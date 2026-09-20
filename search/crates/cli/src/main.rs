use clap::{Parser, Subcommand};
use search_backend::SearchBackend;
use search_model::{SearchRequest, Sort};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(about = "Disk-backed X search. Imports and postings stay on this machine.")]
struct Cli {
    /// Index directory. Falls back to `<base-dir>/index`.
    #[arg(long, env = "SEARCH_INDEX")]
    index: Option<PathBuf>,
    /// Single data root deriving index/archive/drop/state/logs. Flag > env.
    #[arg(long, env = "SEARCH_BASE_DIR")]
    base_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

/// Resolve a directory: explicit flag/env wins, else `<base-dir>/<subdir>`.
fn resolve_dir(
    explicit: Option<PathBuf>,
    base_dir: Option<&PathBuf>,
    subdir: &str,
    hint: &str,
) -> color_eyre::Result<PathBuf> {
    if let Some(dir) = explicit {
        return Ok(dir);
    }
    base_dir
        .map(|base| base.join(subdir))
        .ok_or_else(|| color_eyre::eyre::eyre!("Set {hint} or --base-dir / SEARCH_BASE_DIR."))
}

#[derive(Subcommand)]
enum Command {
    /// Retain and import an x.md JSON dump or capture. Never calls a provider.
    Import {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        archive: PathBuf,
    },
    /// Run one search and print the version-1 JSON response.
    Query {
        query: String,
        #[arg(long, default_value = "relevance", value_parser = ["relevance", "engagement", "likes", "newest", "oldest"])]
        sort: String,
        /// Include backend timing and ranking counters in the JSON response.
        #[arg(long)]
        stats: bool,
    },
    /// Serve the existing app contract on loopback.
    Serve {
        #[arg(long, default_value = "127.0.0.1:4320")]
        listen: SocketAddr,
    },
    /// Watch a drop directory and import per-user dumps in the background.
    Watch {
        #[arg(long, env = "SEARCH_ARCHIVE_DIR")]
        archive: Option<PathBuf>,
        #[arg(long, env = "SEARCH_DROP_DIR")]
        drop_dir: Option<PathBuf>,
        #[arg(long, env = "SEARCH_STATE_DIR")]
        state_dir: Option<PathBuf>,
        #[arg(long, env = "SEARCH_POLL_SECS", default_value_t = 15)]
        poll_secs: u64,
    },
    /// Inspect or override the per-user ingestion registry.
    Users {
        #[command(subcommand)]
        action: UsersAction,
    },
    /// Republish one handle's current live count to Convex's
    /// `/publication/update` by hand, without reimporting anything. Reads
    /// `PUBLICATION_UPDATE_URL` / `PUBLICATION_SERVICE_TOKEN` (or
    /// `DATA_SERVICE_TOKEN`) from the environment; fails if either is unset.
    Publish {
        #[arg(long, env = "SEARCH_STATE_DIR")]
        state_dir: Option<PathBuf>,
        handle: String,
    },
}

#[derive(Subcommand)]
enum UsersAction {
    /// Print the registry as JSON, optionally filtered by status.
    List {
        #[arg(long, env = "SEARCH_STATE_DIR")]
        state_dir: Option<PathBuf>,
        #[arg(long, value_parser = ["complete", "incomplete", "error"])]
        status: Option<String>,
    },
    /// Print imported capture batches keyed by content hash.
    Captures {
        #[arg(long, env = "SEARCH_STATE_DIR")]
        state_dir: Option<PathBuf>,
    },
    /// Mark a user complete, incomplete, or error by hand.
    Mark {
        #[arg(long, env = "SEARCH_STATE_DIR")]
        state_dir: Option<PathBuf>,
        handle: String,
        #[arg(value_parser = ["complete", "incomplete", "error"])]
        status: String,
        #[arg(long)]
        note: Option<String>,
    },
}

fn run_import(
    index: &std::path::Path,
    input: &std::path::Path,
    archive: &std::path::Path,
) -> color_eyre::Result<()> {
    let engine = search_tantivy::open(index, true)?;
    let writer = engine.writer()?;
    let receipt = search_ingest::import(input, archive, writer)?;
    println!("{}", serde_json::to_string(&receipt)?);
    Ok(())
}

fn run_query(
    index: &std::path::Path,
    query: &str,
    sort: &str,
    include_stats: bool,
) -> color_eyre::Result<()> {
    let engine = search_tantivy::open(index, false)?;
    let sort: Sort = serde_json::from_value(serde_json::Value::String(sort.to_owned()))?;
    let expression = search_query::parse(query, None)?;
    let request = SearchRequest {
        version: 1,
        query: query.to_owned(),
        author: None,
        sort,
        limit: 20,
        cursor: None,
        include_stats,
    };
    println!(
        "{}",
        serde_json::to_string(&engine.search(
            &expression,
            &request,
            jiff::Timestamp::now().as_millisecond()
        )?)?
    );
    Ok(())
}

/// One `users list` row: the existing per-user ingestion record, flattened,
/// plus this account's publication state (`None` when nothing has ever
/// been sent for it — including when the sender is disabled).
#[derive(serde::Serialize)]
struct UserListEntry {
    #[serde(flatten)]
    user: search_indexer::users::UserRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    publication: Option<search_indexer::users::PublicationRecord>,
}

fn run_users_list(state_dir: &std::path::Path, status: Option<String>) -> color_eyre::Result<()> {
    let mut registry =
        search_indexer::users::Registry::load(&search_indexer::users::registry_path(state_dir))?;
    let status: Option<search_indexer::users::UserStatus> =
        status.map(|s| s.parse()).transpose()?;
    let users: std::collections::BTreeMap<_, _> = registry
        .users
        .drain()
        .filter(|(_, record)| status.is_none_or(|s| record.status == s))
        .map(|(handle, user)| {
            let publication = registry.publications.get(&handle).cloned();
            (handle, UserListEntry { user, publication })
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&users)?);
    Ok(())
}

fn run_publish(
    index: &std::path::Path,
    state_dir: &std::path::Path,
    handle: &str,
) -> color_eyre::Result<()> {
    // Hold the same exclusive lock a watcher pass and `users mark` take.
    // Without it a watcher that loaded the registry before this send can
    // save its older copy afterwards, putting the generation watermark
    // back — and the receiver ignores an update that reuses a generation
    // it has already committed.
    let _guard = search_indexer::acquire_exclusive(state_dir, "publish")?;
    let handle = search_query::normalize_author(handle)?;
    let Some(config) = search_indexer::publish::PublishConfig::from_env() else {
        color_eyre::eyre::bail!(
            "publication sender disabled: set PUBLICATION_UPDATE_URL and \
             PUBLICATION_SERVICE_TOKEN (or DATA_SERVICE_TOKEN) first."
        );
    };
    let engine = search_tantivy::open(index, false)?;
    let path = search_indexer::users::registry_path(state_dir);
    let mut registry = search_indexer::users::Registry::load(&path)?;
    // An update this account already reserved a generation for has to go
    // out first, exactly as it was built: the receiver treats a reused
    // generation carrying different content as a sender-side bug. If the
    // endpoint is still down this replay fails and the fresh send below
    // stands down rather than reusing that generation.
    search_indexer::publish::replay_pending(Some(&config), &mut registry, &handle);
    search_indexer::publish::report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &search_indexer::publish::ImportReport {
            handle: &handle,
            outcome: search_indexer::publish::ImportOutcome::Succeeded,
            provider_account_id: None,
            run_id: None,
            capture_ids: Vec::new(),
        },
    );
    registry.save(&path)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&registry.publications.get(&handle))?
    );
    Ok(())
}

fn run_users_captures(state_dir: &std::path::Path) -> color_eyre::Result<()> {
    let registry =
        search_indexer::users::Registry::load(&search_indexer::users::registry_path(state_dir))?;
    let captures: std::collections::BTreeMap<_, _> = registry.captures.into_iter().collect();
    println!("{}", serde_json::to_string_pretty(&captures)?);
    Ok(())
}

fn run_users_mark(
    state_dir: &std::path::Path,
    handle: &str,
    status: &str,
    note: Option<&str>,
) -> color_eyre::Result<()> {
    // Hold the mark section under the same lock the watcher uses, so a
    // starting watcher waits instead of overwriting the change, and a
    // running watcher makes this fail instead of silently reverting.
    let _guard = search_indexer::acquire_exclusive(state_dir, "mark")?;
    let handle = search_query::normalize_author(handle)?;
    let path = search_indexer::users::registry_path(state_dir);
    let mut registry = search_indexer::users::Registry::load(&path)?;
    registry.mark(&handle, status.parse()?, note)?;
    registry.save(&path)?;
    println!("{{\"user\":\"{handle}\",\"status\":\"{status}\"}}");
    Ok(())
}

async fn run_serve(index: &std::path::Path, listen: SocketAddr) -> color_eyre::Result<()> {
    color_eyre::eyre::ensure!(
        listen.ip().is_loopback(),
        "Bind loopback; expose only through the authenticated proxy."
    );
    let key = std::env::var("SEARCH_LOCAL_SIGNING_KEY")?.into_bytes();
    let bearer = std::env::var("SEARCH_SERVICE_TOKEN")?.into_bytes();
    let engine = Arc::new(search_tantivy::open(index, false)?);
    let app = search_api::router(engine, key, bearer)?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    eprintln!("Search listening on {listen}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[tokio::main(worker_threads = 2)]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let cli = Cli::parse();
    // Owned copies so match arms can move variant data and still resolve.
    let top_index = cli.index.clone();
    let top_base = cli.base_dir.clone();
    let resolve_top_index = || {
        resolve_dir(
            top_index.clone(),
            top_base.as_ref(),
            "index",
            "--index / SEARCH_INDEX",
        )
    };
    let resolve_top_state = |state_dir| {
        resolve_dir(
            state_dir,
            top_base.as_ref(),
            "state",
            "--state-dir / SEARCH_STATE_DIR",
        )
    };
    match cli.command {
        Command::Import { input, archive } => run_import(&resolve_top_index()?, &input, &archive),
        Command::Query { query, sort, stats } => {
            run_query(&resolve_top_index()?, &query, &sort, stats)
        }
        Command::Watch {
            archive,
            drop_dir,
            state_dir,
            poll_secs,
        } => {
            let config = search_indexer::Config {
                index: resolve_top_index()?,
                archive: resolve_dir(
                    archive,
                    top_base.as_ref(),
                    "archive",
                    "--archive / SEARCH_ARCHIVE_DIR",
                )?,
                drop_dir: resolve_dir(
                    drop_dir,
                    top_base.as_ref(),
                    "drop",
                    "--drop-dir / SEARCH_DROP_DIR",
                )?,
                state_dir: resolve_dir(
                    state_dir,
                    top_base.as_ref(),
                    "state",
                    "--state-dir / SEARCH_STATE_DIR",
                )?,
                poll_interval: std::time::Duration::from_secs(poll_secs.clamp(1, 3600)),
                publish: search_indexer::publish::PublishConfig::from_env(),
            };
            eprintln!(
                "indexer resolved index={} archive={} drop={} state={} publish={}",
                config.index.display(),
                config.archive.display(),
                config.drop_dir.display(),
                config.state_dir.display(),
                if config.publish.is_some() {
                    "enabled"
                } else {
                    "disabled"
                },
            );
            search_indexer::watch(config).await?;
            Ok(())
        }
        Command::Users { action } => match action {
            UsersAction::List { state_dir, status } => {
                run_users_list(&resolve_top_state(state_dir)?, status)
            }
            UsersAction::Captures { state_dir } => {
                run_users_captures(&resolve_top_state(state_dir)?)
            }
            UsersAction::Mark {
                state_dir,
                handle,
                status,
                note,
            } => run_users_mark(
                &resolve_top_state(state_dir)?,
                &handle,
                &status,
                note.as_deref(),
            ),
        },
        Command::Serve { listen } => run_serve(&resolve_top_index()?, listen).await,
        Command::Publish { state_dir, handle } => run_publish(
            &resolve_top_index()?,
            &resolve_top_state(state_dir)?,
            &handle,
        ),
    }
}

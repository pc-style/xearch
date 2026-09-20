# Xearch

Search X posts, import account histories through x.md, and read the pages behind
the links. React is the frontend; Convex owns application state and integrations.
Pronsh owns the separate search and indexing implementation.

## Repository map

| Path              | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `src/`            | React application and styles                                    |
| `convex/`         | Application backend, ownership, jobs, and provider integrations |
| `search/`         | Pronsh's Rust search and indexing workspace                     |
| `tests/`          | Application tests; Rust tests stay with their crates            |
| `scripts/`        | Setup, acquisition, and operations commands                     |
| `deploy/`         | systemd units and nginx configuration                           |
| `docs/`           | Development, product, integration, and operations documentation |
| `.agents/skills/` | Canonical project skills; `.claude/skills` links here           |

`to-do.md` is the application backlog. `hackathon.md` stays at the root for the
submission, and `DECISIONS.md` records implementation decisions. Tool configs,
`package.json`, and `bun.lock` stay at the root where their tools expect them.

## Start here

- [Application backlog](to-do.md)
- [Local development, dashboard, and provider configuration](docs/development.md)
- [Production operations](docs/production.md)
- [Application/search integration contract](docs/integration-contract.md)
- [Product responsibilities](docs/product.md) and [spec adoption](docs/spec-adoption.md)
- [Hackathon build evidence](hackathon.md)

The VM frontend is https://exp-xearch.exe.xyz/ through the private exe.dev proxy.
The hosted frontend is https://utmost-kudu-321.convex.site. This VM is production:
do not run local setup, paid imports, or service restarts as routine verification.

## Keep the checkout clean

- Dependencies, build output, local Convex state, and runtime data are ignored by
  Git and hidden in the VS Code explorer. They are not deleted or relocated by
  editor settings; use **File: Open File** or the terminal to inspect them.
- Keep screenshots worth reviewing under `docs/design/`, not at the root. Check
  them for private data before committing. Do not commit captures or credentials.
- Keep reference repositories outside this checkout. The old
  [Xearch reference](https://github.com/Priyansh4444/xearch) on this VM lives at
  `/home/exedev/xearch-reference`; it is not an application dependency.
- Edit project skills only in `.agents/skills/`. The relative Claude symlink
  prevents duplicate copies from drifting. Preserve symlinks when checking out
  the repository.

The `/hackathon` skill and its upstream license are in
[`.agents/skills/hackathon`](.agents/skills/hackathon/README.md).

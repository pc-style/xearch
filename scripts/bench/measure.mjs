#!/usr/bin/env node
/**
 * Measure one or more checkouts of this repo and write one JSON file of
 * metrics per checkout. Used by .github/workflows/perf.yml, which measures a
 * pull request and its base on the same runner so machine noise cancels out,
 * and by `bun run bench` locally.
 *
 *   node scripts/bench/measure.mjs base=../base head=. --out-dir perf/results
 *
 * Every metric is "lower is better" and carries a unit, which
 * scripts/bench/compare.mjs uses to pick its noise floor:
 *
 * - bytes: gzip size of what the browser downloads, and the minified size of
 *   each Convex function module (what an isolate parses on a cold start).
 * - ms: a cold page load of the built site in headless Chromium, throttled to
 *   a slow phone on a slow network, with a fixed delay per file standing in
 *   for static hosting. Checkouts are measured interleaved, run by run, so a
 *   noisy moment on the runner hits both sides.
 * - ns: the Rust search engine's criterion benchmark (`--rust` only).
 *
 * Nothing talks to a real backend: the site is built against an unreachable
 * Convex URL and every request that leaves the local server is aborted.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);

const flag = (name, fallback) => {
  const at = args.indexOf(name);

  return at === -1 ? fallback : args[at + 1];
};

const checkouts = args
  .filter((arg) => /^[\w-]+=/.test(arg))
  .map((arg) => {
    const [label, dir] = arg.split(/=(.*)/s);

    return { label, dir: resolve(dir) };
  });

const outDir = resolve(flag("--out-dir", "perf/results"));

const runs = Number(flag("--runs", "7"));

const rustRounds = Number(flag("--rust-rounds", "2"));

const withRust = args.includes("--rust");

// Mirrors the lab profile used when tuning the page: a mid-range phone on a
// slow 4G connection, with static hosting's time-to-first-byte per file.
const LATENCY_MS = 150;

const DOWNLOAD_BPS = (1.6 * 1024 * 1024) / 8;

const UPLOAD_BPS = (750 * 1024) / 8;

const CPU_SLOWDOWN = 4;

const FILE_DELAY_MS = 250;

const UNREACHABLE_CONVEX = "https://bench.invalid";

if (!checkouts.length) {
  console.error(
    "usage: measure.mjs <label>=<dir> [<label>=<dir> ...] [--out-dir dir] [--runs n] [--rust]",
  );
  process.exit(2);
}

function run(command, commandArgs, options) {
  const result = spawnSync(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], ...options });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed in ${options.cwd}:\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result.stdout.toString();
}

const gzipBytes = (buffer) => gzipSync(buffer, { level: 9 }).length;

async function build(checkout) {
  const work = join(tmpdir(), "xearch-bench", checkout.label);
  const env = { ...process.env, VITE_CONVEX_URL: UNREACHABLE_CONVEX, NODE_ENV: "production" };

  // Never upload sourcemaps or tag a PostHog release from a benchmark build.
  for (const key of Object.keys(env)) if (key.startsWith("POSTHOG_")) delete env[key];
  await rm(work, { recursive: true, force: true });
  const vite = join(checkout.dir, "node_modules", ".bin", "vite");

  run(vite, ["build", "--outDir", join(work, "public"), "--emptyOutDir"], {
    cwd: checkout.dir,
    env,
  });
  run(vite, ["build", "--outDir", join(work, "operator"), "--emptyOutDir"], {
    cwd: checkout.dir,
    env: { ...env, VITE_XEARCH_OPERATOR: "1" },
  });

  return { ...checkout, publicDir: join(work, "public"), operatorDir: join(work, "operator") };
}

async function files(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function bundleSizes(built) {
  const metrics = {};
  const html = await readFile(join(built.publicDir, "index.html"));

  // Everything index.html makes the browser fetch before the app can run:
  // the HTML itself, its stylesheets, and its entry script and preloads.
  const referenced = [
    ...html.toString().matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g),
  ].map((match) => match[1]);

  let firstLoad = gzipBytes(html);

  for (const path of new Set(referenced))
    firstLoad += gzipBytes(await readFile(join(built.publicDir, path)));
  metrics["page.first-load"] = { value: firstLoad, unit: "bytes" };

  for (const [name, dir] of [
    ["page.all-js", built.publicDir],
    ["operator.all-js", built.operatorDir],
  ]) {
    let total = 0;

    for (const file of await files(dir))
      if (extname(file) === ".js") total += gzipBytes(await readFile(file));
    metrics[name] = { value: total, unit: "bytes" };
  }

  return metrics;
}

/**
 * Minified size of each top-level Convex module, bundled roughly the way
 * `convex deploy` does. Uses the checkout's own esbuild and dependencies, so
 * a dependency change shows up on the side that made it.
 */
async function convexSizes(checkout) {
  const metrics = {};
  const esbuildEntry = join(checkout.dir, "node_modules", "esbuild", "lib", "main.js");
  const { build: esbuild } = await import(pathToFileURL(esbuildEntry).href);
  const dir = join(checkout.dir, "convex");

  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name === "convex.config.ts") continue;
    const entry = join(dir, name);
    const source = await readFile(entry, "utf8");
    const node = /^\s*["']use node["']/m.test(source.slice(0, 200));

    try {
      const result = await esbuild({
        absWorkingDir: checkout.dir,
        entryPoints: [entry],
        bundle: true,
        minify: true,
        format: "esm",
        platform: node ? "node" : "browser",
        conditions: ["convex", "module"],
        write: false,
        logLevel: "silent",
        outfile: "out.js",
      });

      metrics[`convex.${name.replace(/\.ts$/, "")}`] = {
        value: result.outputFiles[0].contents.length,
        unit: "bytes",
      };
    } catch (error) {
      console.warn(`skipping convex/${name}: ${error.message.split("\n")[0]}`);
    }
  }

  return metrics;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Static server with gzip and a fixed per-file delay, like Convex static hosting. */
function serve(root) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    let file = join(root, path);

    if (!file.startsWith(root) || !existsSync(file) || path.endsWith("/"))
      file = join(root, "index.html");
    const body = await readFile(file).catch(() => readFile(join(root, "index.html")));
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const compressible = /text|javascript|json|svg|manifest/.test(type);

    setTimeout(() => {
      response.setHeader("content-type", type);
      response.setHeader("cache-control", "no-store");

      if (compressible) response.setHeader("content-encoding", "gzip");
      response.writeHead(200);
      response.end(compressible ? gzipSync(body) : body);
    }, FILE_DELAY_MS);
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

// Runs in the page before any of its own scripts.
function observe() {
  const state = { longTasks: [], lcp: 0, ready: 0 };

  window.__bench = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.longTasks.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });

  // The app has mounted once #root holds something other than the static
  // shell (older builds have no shell, so any child counts there).
  const poll = () => {
    if (document.querySelector("#root > :not([data-shell])")) state.ready = performance.now();
    else requestAnimationFrame(poll);
  };

  requestAnimationFrame(poll);
}

async function pageLoad(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  });

  const origin = new URL(url).origin;

  await context.route(
    (target) => target.origin !== origin,
    (route) => route.abort(),
  );
  await context.addInitScript(observe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY_MS,
    downloadThroughput: DOWNLOAD_BPS,
    uploadThroughput: UPLOAD_BPS,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__bench.ready > 0, null, { timeout: 60_000 });
  // Let anything the mount kicked off finish, so its long tasks count.
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const state = window.__bench;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;

    // Counted from navigation, not from first paint like Lighthouse's TBT:
    // a page that paints only after its JS runs would otherwise score 0.
    const blocking = state.longTasks.reduce(
      (sum, [, duration]) => sum + Math.max(0, duration - 50),
      0,
    );

    return { fcp, lcp: state.lcp || fcp, ready: state.ready, blocking };
  });

  await context.close();

  return result;
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function pageLoads(builts) {
  const servers = await Promise.all(builts.map((built) => serve(built.publicDir)));
  const browser = await chromium.launch();
  const samples = builts.map(() => ({ fcp: [], lcp: [], ready: [], blocking: [] }));

  try {
    // One throwaway load per side warms the browser process itself.
    for (const server of servers)
      await pageLoad(browser, `http://127.0.0.1:${server.address().port}/`);

    for (let round = 0; round < runs; round += 1) {
      for (const [index, server] of servers.entries()) {
        const result = await pageLoad(browser, `http://127.0.0.1:${server.address().port}/`);

        for (const key of Object.keys(result)) samples[index][key].push(result[key]);
      }
    }
  } finally {
    await browser.close();

    for (const server of servers) server.close();
  }

  return samples.map((sample) => ({
    "load.first-contentful-paint": { value: Math.round(median(sample.fcp)), unit: "ms" },
    "load.largest-contentful-paint": { value: Math.round(median(sample.lcp)), unit: "ms" },
    "load.app-ready": { value: Math.round(median(sample.ready)), unit: "ms" },
    "load.main-thread-blocking": { value: Math.round(median(sample.blocking)), unit: "ms" },
  }));
}

async function criterionResults(root) {
  const results = {};

  if (!existsSync(root)) return results;

  for (const file of await files(root)) {
    if (!file.endsWith(join("new", "benchmark.json"))) continue;
    const { full_id: id } = JSON.parse(await readFile(file, "utf8"));

    const estimates = JSON.parse(
      await readFile(file.replace("benchmark.json", "estimates.json"), "utf8"),
    );

    results[`search.${id}`] = estimates.median.point_estimate;
  }

  return results;
}

/**
 * The Rust search benchmark, rounds interleaved across checkouts. All of them
 * share one target directory so dependencies compile once; each round clears
 * criterion's output and reads it back straight away. Keeps the fastest
 * round per benchmark, since noise on a shared runner only ever adds time.
 */
async function searchBench() {
  const target = process.env.CARGO_TARGET_DIR ?? join(checkouts[0].dir, "search", "target");
  const criterion = join(target, "criterion");
  const best = checkouts.map(() => ({}));

  for (let round = 0; round < rustRounds; round += 1) {
    for (const [index, checkout] of checkouts.entries()) {
      await rm(criterion, { recursive: true, force: true });
      run(
        "cargo",
        [
          "bench",
          "--locked",
          "-p",
          "search-tantivy",
          "--bench",
          "search",
          "--",
          "--warm-up-time",
          "1",
          "--measurement-time",
          "3",
          "--noplot",
        ],
        { cwd: join(checkout.dir, "search"), env: { ...process.env, CARGO_TARGET_DIR: target } },
      );

      for (const [id, nanos] of Object.entries(await criterionResults(criterion)))
        best[index][id] = Math.min(best[index][id] ?? Infinity, nanos);
    }
  }

  return best.map((results) =>
    Object.fromEntries(
      Object.entries(results).map(([id, nanos]) => [id, { value: Math.round(nanos), unit: "ns" }]),
    ),
  );
}

await mkdir(outDir, { recursive: true });

const builts = [];

for (const checkout of checkouts) {
  console.log(`building ${checkout.label} (${checkout.dir})`);
  builts.push(await build(checkout));
}

const measured = [];

for (const built of builts)
  measured.push({ ...(await bundleSizes(built)), ...(await convexSizes(built)) });

console.log(`loading each site ${runs} times`);

const loads = await pageLoads(builts);

const search = withRust ? await searchBench() : builts.map(() => ({}));

for (const [index, built] of builts.entries()) {
  const metrics = { ...measured[index], ...loads[index], ...search[index] };
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: built.dir }).trim();
  const file = join(outDir, `${built.label}.json`);

  await writeFile(file, `${JSON.stringify({ commit, rust: withRust, metrics }, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

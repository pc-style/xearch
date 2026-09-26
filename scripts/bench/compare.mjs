#!/usr/bin/env node
/**
 * Compare benchmark results from scripts/bench/measure.mjs.
 *
 * Pull request mode — flags any metric more than 10% worse than the base
 * branch measured in the same run, and writes a markdown report:
 *
 *   node scripts/bench/compare.mjs --base base.json --head head.json \
 *     --baseline perf/baseline.json --report report.md --summary summary.json
 *
 * Baseline mode — on main, records every metric that improved more than 10%
 * over perf/baseline.json (and any metric the baseline has not seen yet):
 *
 *   node scripts/bench/compare.mjs --update-baseline perf/baseline.json --head head.json
 *
 * The baseline is a ratchet of the best numbers main has reached. A pull
 * request is judged against its own base, so it is never blamed for drift it
 * did not cause; the baseline shows when small regressions have added up.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const THRESHOLD = 0.1;

/**
 * Changes smaller than this never count, whatever their percentage: a few
 * hundred bytes on a tiny module, or a couple of ms of timer jitter, is not a
 * regression anyone should chase.
 */
const NOISE_FLOOR = { bytes: 512, ms: 30, ns: 500 };

/** Timings depend on the machine, so only sizes are compared across runs. */
const COMPARABLE_ACROSS_RUNS = new Set(["bytes"]);

const args = process.argv.slice(2);

const flag = (name) => {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** "regression", "improvement", or undefined when the change is within noise. */
function verdict(before, after, unit) {
  const delta = after - before;

  if (Math.abs(delta) < (NOISE_FLOOR[unit] ?? 0)) return undefined;
  const ratio = before === 0 ? (delta > 0 ? Infinity : 0) : delta / before;

  if (ratio > THRESHOLD) return "regression";

  if (ratio < -THRESHOLD) return "improvement";

  return undefined;
}

function format(value, unit) {
  if (unit === "bytes") return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;

  if (unit === "ns")
    return value >= 1e6 ? `${(value / 1e6).toFixed(2)} ms` : `${(value / 1e3).toFixed(1)} µs`;

  return `${value} ms`;
}

function change(before, after) {
  if (before === 0) return after === 0 ? "0%" : "new";
  const percent = ((after - before) / before) * 100;

  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

const GROUPS = [
  ["page.", "Page bundle (gzip)"],
  ["operator.", "Operator bundle (gzip)"],
  ["load.", "Page load (throttled phone, median)"],
  ["convex.", "Convex function modules (minified)"],
  ["search.", "Search engine (criterion median)"],
];

const groupOf = (name) => GROUPS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "Other";

/**
 * What the page-load numbers mean. They come from a deliberately harsh
 * profile, and most of first paint is waiting on the network and hosting,
 * which no code change can win back — so say so next to the numbers.
 */
function pageLoadNote(head) {
  const profile = head.profile;
  const firstByte = head.metrics["load.html-first-byte"]?.value;
  const firstPaint = head.metrics["load.first-contentful-paint"]?.value;
  const lines = [];

  if (profile)
    lines.push(
      `Measured as a slow phone on a slow connection: ${profile.cpuSlowdown}× CPU slowdown, ${profile.latencyMs} ms round trip, ${profile.downloadMbps} Mbps, plus ${profile.fileDelayMs} ms per file for static hosting's server time. Real devices on good connections are much faster.`,
    );

  if (firstByte !== undefined && firstPaint !== undefined)
    lines.push(
      "",
      `Of the ${firstPaint} ms to first paint, ${firstByte} ms is waiting for the HTML to start arriving (network plus hosting), which no code change can remove; the other ${Math.max(0, firstPaint - firstByte)} ms is downloading and drawing the page.`,
      "",
      "On production, Convex static hosting takes about 550–640 ms before the first byte of each file. A CDN in front of the site (for example Cloudflare, caching the HTML briefly and hashed assets for good) would cut that to tens of ms and add Brotli, which is the biggest first-paint win left.",
    );

  return lines.join("\n");
}

async function compare() {
  const base = await readJson(flag("--base"));
  const head = await readJson(flag("--head"));
  const baselinePath = flag("--baseline");

  const baseline =
    baselinePath && existsSync(baselinePath) ? await readJson(baselinePath) : undefined;

  const rows = [];
  const regressions = [];
  const improvements = [];
  const drift = [];

  for (const [name, { value, unit }] of Object.entries(head.metrics)) {
    const before = base.metrics[name]?.value;
    const status = before === undefined ? "added" : verdict(before, value, unit);

    rows.push({ name, unit, before, after: value, status });

    if (status === "regression") regressions.push(name);

    if (status === "improvement") improvements.push(name);
    const best = baseline?.metrics[name];

    if (
      best &&
      COMPARABLE_ACROSS_RUNS.has(unit) &&
      verdict(best.value, value, unit) === "regression"
    )
      drift.push({ name, unit, best: best.value, after: value });
  }

  for (const name of Object.keys(base.metrics))
    if (!(name in head.metrics) && (head.rust || !name.startsWith("search.")))
      rows.push({
        name,
        unit: base.metrics[name].unit,
        before: base.metrics[name].value,
        status: "removed",
      });

  const icon = { regression: "🔴", improvement: "🟢", added: "🆕", removed: "➖" };

  const table = (subset) =>
    [
      "| Metric | Base | This PR | Change |",
      "|---|---:|---:|---:|",
      ...subset.map(
        (row) =>
          `| ${icon[row.status] ?? ""} \`${row.name}\` | ${row.before === undefined ? "–" : format(row.before, row.unit)} | ${row.after === undefined ? "–" : format(row.after, row.unit)} | ${row.before === undefined || row.after === undefined ? "–" : change(row.before, row.after)} |`,
      ),
    ].join("\n");

  const lines = ["<!-- perf-bench -->", "## Performance check", ""];

  lines.push(
    regressions.length
      ? `🔴 **${regressions.length} metric${regressions.length === 1 ? "" : "s"} got more than ${THRESHOLD * 100}% worse than the base branch.** If this is intended, add the \`perf-regression-ok\` label.`
      : `✅ Nothing got more than ${THRESHOLD * 100}% worse than the base branch.`,
  );

  if (improvements.length)
    lines.push(
      "",
      `🟢 ${improvements.length} metric${improvements.length === 1 ? "" : "s"} improved by more than ${THRESHOLD * 100}%. Once merged, main's baseline records them.`,
    );
  const notable = rows.filter((row) => row.status);

  if (notable.length) lines.push("", table(notable));

  if (drift.length)
    lines.push(
      "",
      `⚠️ Worse than the best main has recorded (\`perf/baseline.json\`) by more than ${THRESHOLD * 100}%, across several changes rather than this one alone:`,
      "",
      "| Metric | Best on main | This PR | Change |",
      "|---|---:|---:|---:|",
      ...drift.map(
        (row) =>
          `| \`${row.name}\` | ${format(row.best, row.unit)} | ${format(row.after, row.unit)} | ${change(row.best, row.after)} |`,
      ),
    );

  if (!head.rust)
    lines.push("", "_Search engine benchmark skipped: this PR does not touch `search/`._");

  for (const [prefix, title] of GROUPS) {
    const subset = rows.filter((row) => groupOf(row.name) === title);

    if (!subset.length) continue;
    lines.push("", `<details><summary>${title}</summary>`, "", table(subset));

    if (prefix === "load.") lines.push("", pageLoadNote(head));
    lines.push("", "</details>");
  }

  lines.push(
    "",
    `<sub>Base \`${base.commit.slice(0, 7)}\` vs this PR \`${head.commit.slice(0, 7)}\`, measured on the same runner. Flagged when more than ${THRESHOLD * 100}% worse and above the noise floor (${format(NOISE_FLOOR.bytes, "bytes")}, ${NOISE_FLOOR.ms} ms, ${format(NOISE_FLOOR.ns, "ns")}).</sub>`,
  );
  await writeFile(flag("--report"), `${lines.join("\n")}\n`);
  await writeFile(
    flag("--summary"),
    `${JSON.stringify({ regressions, improvements, drift: drift.map((row) => row.name) }, null, 2)}\n`,
  );
  console.log(`${regressions.length} regression(s), ${improvements.length} improvement(s)`);
}

async function updateBaseline() {
  const path = flag("--update-baseline");
  const head = await readJson(flag("--head"));
  const baseline = existsSync(path) ? await readJson(path) : { metrics: {} };
  const changed = [];

  for (const [name, { value, unit }] of Object.entries(head.metrics)) {
    const best = baseline.metrics[name];

    if (best && best.unit === unit && verdict(best.value, value, unit) !== "improvement") continue;
    baseline.metrics[name] = { value, unit, commit: head.commit };
    changed.push(
      best ? `${name}: ${format(best.value, unit)} → ${format(value, unit)}` : `${name}: new`,
    );
  }

  // A module or benchmark that no longer exists has nothing to ratchet.
  for (const name of Object.keys(baseline.metrics))
    if (!(name in head.metrics) && (head.rust || !name.startsWith("search."))) {
      delete baseline.metrics[name];
      changed.push(`${name}: removed`);
    }

  if (!changed.length) {
    console.log("baseline unchanged");

    return;
  }

  baseline.metrics = Object.fromEntries(
    Object.entries(baseline.metrics).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  // The first baseline creates its directory.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(changed.join("\n"));
}

await (flag("--update-baseline") ? updateBaseline() : compare());

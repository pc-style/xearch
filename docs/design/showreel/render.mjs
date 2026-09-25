// Renders reel.html to video through headless Chrome's DevTools protocol.
//
//   node render.mjs stills 1.2 4.5 9      one PNG per time, plus sheet.png
//   node render.mjs video                  reel.mp4 with motion blur and sound
//   node render.mjs encode                 re-mux existing chunks with new audio
//
// Each output frame averages SUB samples across a 180° shutter in linear
// light, and FAST samples on the fastest moves, where fewer samples show as
// stepped copies. Output goes to $OUT (default /tmp/xreel/out). $CHROME
// overrides the browser; otherwise the newest Playwright headless shell is used.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const OUT = process.env.OUT ?? "/tmp/xreel/out";

const FPS = 60,
  DUR = 15,
  SUB = Number(process.env.SUB ?? 4),
  FAST = Number(process.env.FAST ?? 8),
  SHUTTER = 0.5;

// Frame ranges that move fast enough to need FAST samples: the zoom into the
// X, the band wipe, the whip into import, the wall speed-ramp and the burst.
const FAST_FRAMES = [
  [90, 116],
  [206, 228],
  [428, 464],
  [738, 808],
];

const WORKERS = Number(process.env.WORKERS ?? 2);

mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), ".cache/ms-playwright");

  const dirs = existsSync(base)
    ? readdirSync(base)
        .filter((d) => d.startsWith("chromium_headless_shell"))
        .sort()
        .toReversed()
    : [];

  for (const d of dirs) {
    const p = path.join(base, d, "chrome-headless-shell-linux64/chrome-headless-shell");

    if (existsSync(p)) return p;
  }

  throw new Error("no headless Chrome found; set CHROME");
}

async function openPage(n) {
  const profile = path.join(os.tmpdir(), `xreel-chrome-${process.pid}-${n}`);

  const proc = spawn(
    "nice",
    [
      "-n",
      "15",
      findChrome(),
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--hide-scrollbars",
      "--window-size=1920,1080",
      "--force-device-scale-factor=1",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const wsUrl = await new Promise((res, rej) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);

      if (m) res(m[1]);
    });
    proc.on("exit", (c) => rej(new Error(`chrome exited ${c}: ${buf}`)));
  });

  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);

    if (!p) return;
    pending.delete(m.id);

    if (m.error) p.rej(new Error(m.error.message));
    else p.res(m.result);
  });

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

    return r.result.value;
  };

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: pathToFileURL(path.join(here, "reel.html")).href });

  for (let i = 0; i < 200; i++) {
    if (
      await evaluate("window.__ready ? window.__ready.then(() => true) : false").catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    evaluate,
    async shot(t) {
      await evaluate(`__seek(${t})`);

      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        optimizeForSpeed: true,
      });

      return Buffer.from(data, "base64");
    },
    close() {
      ws.close();
      proc.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const run = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });

async function stills(times) {
  const page = await openPage(0);
  const files = [];

  for (const t of times) {
    const f = path.join(OUT, `still-${String(t).padStart(6, "0")}.png`);
    writeFileSync(f, await page.shot(Number(t)));
    files.push(f);
    console.log(f);
  }

  page.close();

  if (files.length > 1) {
    const cols = Math.min(4, files.length),
      rows = Math.ceil(files.length / cols);

    run([
      ...files.flatMap((f) => ["-i", f]),
      "-filter_complex",
      files.map((_, i) => `[${i}:v]scale=480:270[v${i}]`).join(";") +
        ";" +
        files.map((_, i) => `[v${i}]`).join("") +
        `xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join("|")}:fill=black`,
      "-frames:v",
      "1",
      path.join(OUT, "sheet.png"),
    ]);
    console.log(path.join(OUT, "sheet.png"), `${cols}x${rows}`);
  }
}

// Linear-light average of each group of `sub` samples, then back to sRGB.
const blur = (sub) =>
  `zscale=tin=iec61966-2-1:t=linear,format=gbrpf32le,tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',zscale=tin=linear:t=iec61966-2-1,format=gbrp,setpts=N/${FPS}/TB`;

async function chunk(page, n, from, to, sub) {
  const file = path.join(OUT, `chunk-${String(n).padStart(2, "0")}.mkv`);

  const ff = spawn(
    "nice",
    [
      "-n",
      "15",
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "-framerate",
      String(FPS * sub),
      "-i",
      "-",
      "-vf",
      blur(sub),
      "-r",
      String(FPS),
      "-c:v",
      "libx264rgb",
      "-preset",
      "ultrafast",
      "-qp",
      "0",
      file,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );

  const done = new Promise((res, rej) =>
    ff.on("exit", (c) => (c === 0 ? res(file) : rej(new Error(`ffmpeg ${c}`)))),
  );

  for (let f = from; f < to; f++) {
    for (let k = 0; k < sub; k++) {
      const t = (f + ((k + 0.5) / sub - 0.5) * SHUTTER) / FPS;
      const png = await page.shot(Math.max(0, t));

      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    }
  }

  ff.stdin.end();

  return done;
}

// Split the reel into ~1s chunks at the FAST_FRAMES edges, so each chunk has
// one sample count, and let the workers pull chunks in order.
function plan() {
  const total = FPS * DUR;
  const edges = new Set([0, total, ...FAST_FRAMES.flat()]);

  for (let f = 0; f < total; f += FPS) edges.add(f);
  const cuts = [...edges].sort((a, b) => a - b);

  return cuts.slice(0, -1).map((from, i) => {
    const to = cuts[i + 1];
    const fast = FAST_FRAMES.some(([a, b]) => from >= a && to <= b);

    return { from, to, sub: fast ? FAST : SUB };
  });
}

async function video() {
  const jobs = plan();
  const cost = jobs.reduce((s, j) => s + (j.to - j.from) * j.sub, 0);
  const t0 = Date.now();

  let next = 0,
    done = 0;

  await Promise.all(
    Array.from({ length: WORKERS }, async (_, w) => {
      const page = await openPage(w);

      while (next < jobs.length) {
        const n = next++;
        const j = jobs[n];
        await chunk(page, n, j.from, j.to, j.sub);
        done += (j.to - j.from) * j.sub;
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(
          `chunk ${n + 1}/${jobs.length} (frames ${j.from}-${j.to}, ${j.sub} samples) · ${((cost - done) / rate / 60).toFixed(1)} min left`,
        );
      }

      page.close();
    }),
  );

  writeFileSync(
    path.join(OUT, "chunks.txt"),
    jobs
      .map((_, n) => `file '${path.join(OUT, `chunk-${String(n).padStart(2, "0")}.mkv`)}'`)
      .join("\n"),
  );
  encode();
}

// Mux the rendered chunks with a freshly synthesized soundtrack.
function encode() {
  const list = path.join(OUT, "chunks.txt");
  const wav = path.join(OUT, "reel.wav");
  execFileSync("node", [path.join(here, "audio.mjs"), wav], { stdio: "inherit" });
  const mp4 = path.join(OUT, "reel.mp4");
  run([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-i",
    wav,
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "14",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-movflags",
    "+faststart",
    "-shortest",
    mp4,
  ]);
  console.log(mp4);

  // A two-pass cut sized for sharing: under 10 MB, the GitHub upload limit.
  const web = path.join(OUT, "reel-web.mp4");
  const log = path.join(OUT, "x264-pass");

  const x264 = [
    "-i",
    mp4,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-b:v",
    "4400k",
    "-maxrate",
    "9000k",
    "-bufsize",
    "9000k",
    "-passlogfile",
    log,
  ];

  run([...x264, "-pass", "1", "-an", "-f", "null", "/dev/null"]);
  run([...x264, "-pass", "2", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", web]);
  console.log(web);
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "stills") await stills(rest);
else if (mode === "video") await video();
else if (mode === "encode") encode();
else console.log("usage: node render.mjs stills <t...> | video | encode");

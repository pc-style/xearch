// Renders reel.html to video through headless Chrome's DevTools protocol.
//
//   node render.mjs stills 1.2 4.5 9      one PNG per time, plus sheet.png
//   node render.mjs video                  reel.mp4 with motion blur and sound
//
// Each output frame averages SUB samples across a 180° shutter in linear
// light. Output goes to $OUT (default /tmp/xreel/out). $CHROME overrides the
// browser; otherwise the newest Playwright headless shell is used.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? "/tmp/xreel/out";
const FPS = 60, DUR = 15, SUB = Number(process.env.SUB ?? 4), SHUTTER = 0.5;
const WORKERS = Number(process.env.WORKERS ?? 2);
mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), ".cache/ms-playwright");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(base, d, "chrome-headless-shell-linux64/chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  throw new Error("no headless Chrome found; set CHROME");
}

async function openPage(n) {
  const profile = path.join(os.tmpdir(), `xreel-chrome-${process.pid}-${n}`);
  const proc = spawn("nice", ["-n", "15", findChrome(), "--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars", "--window-size=1920,1080", "--force-device-scale-factor=1",
    "--font-render-hinting=none", "--disable-lcd-text", "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(path.join(here, "reel.html")).href });
  for (let i = 0; i < 200; i++) {
    if (await evaluate("window.__ready ? window.__ready.then(() => true) : false").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    evaluate,
    async shot(t) {
      await evaluate(`__seek(${t})`);
      const { data } = await send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
      return Buffer.from(data, "base64");
    },
    close() {
      ws.close();
      proc.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const run = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

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
    const cols = Math.min(4, files.length), rows = Math.ceil(files.length / cols);
    run([...files.flatMap((f) => ["-i", f]), "-filter_complex",
      files.map((_, i) => `[${i}:v]scale=480:270[v${i}]`).join(";") + ";" + files.map((_, i) => `[v${i}]`).join("") +
      `xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join("|")}:fill=black`,
      "-frames:v", "1", path.join(OUT, "sheet.png")]);
    console.log(path.join(OUT, "sheet.png"), `${cols}x${rows}`);
  }
}

// Linear-light average of each group of SUB samples, then back to sRGB.
const BLUR = `zscale=tin=iec61966-2-1:t=linear,format=gbrpf32le,tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',zscale=tin=linear:t=iec61966-2-1,format=gbrp,setpts=N/${FPS}/TB`;

async function chunk(n, from, to) {
  const file = path.join(OUT, `chunk-${n}.mkv`);
  const ff = spawn("nice", ["-n", "15", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "png",
    "-framerate", String(FPS * SUB), "-i", "-", "-vf", BLUR, "-r", String(FPS), "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", file],
    { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("exit", (c) => (c === 0 ? res(file) : rej(new Error(`ffmpeg ${c}`)))));
  const page = await openPage(n);
  const t0 = Date.now();
  for (let f = from; f < to; f++) {
    for (let k = 0; k < SUB; k++) {
      const t = (f + ((k + 0.5) / SUB - 0.5) * SHUTTER) / FPS;
      const png = await page.shot(Math.max(0, t));
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    if ((f - from) % 30 === 29) {
      const rate = (f - from + 1) / ((Date.now() - t0) / 1000);
      console.log(`worker ${n}: frame ${f + 1}/${to} · ${rate.toFixed(2)} fps · ${((to - f - 1) / rate / 60).toFixed(1)} min left`);
    }
  }
  page.close();
  ff.stdin.end();
  return done;
}

async function video() {
  const total = FPS * DUR, per = Math.ceil(total / WORKERS);
  const files = await Promise.all(Array.from({ length: WORKERS }, (_, n) => chunk(n, n * per, Math.min(total, (n + 1) * per))));
  const list = path.join(OUT, "chunks.txt");
  writeFileSync(list, files.map((f) => `file '${f}'`).join("\n"));
  const wav = path.join(OUT, "reel.wav");
  execFileSync("node", [path.join(here, "audio.mjs"), wav], { stdio: "inherit" });
  const mp4 = path.join(OUT, "reel.mp4");
  run(["-f", "concat", "-safe", "0", "-i", list, "-i", wav,
    "-vf", "zscale=m=709:r=limited:p=709:t=709,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", "-shortest", mp4]);
  console.log(mp4);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "stills") await stills(rest);
else if (mode === "video") await video();
else console.log("usage: node render.mjs stills <t...> | video");

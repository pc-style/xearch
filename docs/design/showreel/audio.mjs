// Synthesizes the reel's soundtrack on the same 128 BPM grid as reel.html:
// 8 bars of F minor, with every hit, whoosh, and UI sound placed on the frame
// it belongs to. Writes a 48 kHz stereo WAV:  node audio.mjs out.wav
import { writeFileSync } from "node:fs";

const SR = 48000, DUR = 15, N = SR * DUR, BPM = 128, B = 60 / BPM;
const bt = (n) => n * B;
const TAU = Math.PI * 2;
const main = [new Float32Array(N), new Float32Array(N)];
const music = [new Float32Array(N), new Float32Array(N)]; // ducked by the kick
const verb = [new Float32Array(N), new Float32Array(N)];
const duck = new Float32Array(N).fill(1);

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(7);
const white = () => R() * 2 - 1;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const note = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz
const expLerp = (a, b, u) => a * Math.pow(b / a, clamp(u));

function biquad(type) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, lf = -1, lq = -1, b0, b1, b2, a1, a2;
  return (x, f, q = 0.707) => {
    if (f !== lf || q !== lq) {
      lf = f; lq = q;
      const w = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
      else if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
      else { b0 = al; b1 = 0; b2 = -al; }
      b0 /= a0; b1 /= a0; b2 /= a0; a1 = (-2 * c) / a0; a2 = (1 - al) / a0;
    }
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

// Render a mono generator into a bus with equal-power pan (number or fn of t).
function voice(t0, len, gen, { gain = 1, pan = 0, rev = 0, bus = main } = {}) {
  const i0 = Math.round(t0 * SR), n = Math.round(len * SR);
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    if (i < 0 || i >= N) continue;
    const t = k / SR;
    const v = gen(t) * gain;
    const p = typeof pan === "function" ? pan(t) : pan;
    const gl = Math.cos(((p + 1) * Math.PI) / 4), gr = Math.sin(((p + 1) * Math.PI) / 4);
    bus[0][i] += v * gl;
    bus[1][i] += v * gr;
    if (rev) { verb[0][i] += v * gl * rev; verb[1][i] += v * gr * rev; }
  }
}
function sidechain(t0, depth = 0.6, rel = 0.11) {
  const i0 = Math.round(t0 * SR);
  for (let k = 0; k < SR * 0.5; k++) {
    const i = i0 + k;
    if (i >= N) break;
    const t = k / SR;
    const g = 1 - depth * (t < 0.004 ? t / 0.004 : Math.exp(-(t - 0.004) / rel));
    duck[i] = Math.min(duck[i], g);
  }
}

/* instruments ------------------------------------------------------------ */
function kick(t0, g = 1) {
  let ph = 0;
  voice(t0, 0.55, (t) => {
    const f = 46 + 130 * Math.exp(-t * 32) + 60 * Math.exp(-t * 160);
    ph += (TAU * f) / SR;
    const body = Math.sin(ph) * Math.exp(-t * 6) * Math.min(1, t / 0.0015);
    return Math.tanh((body * 1.3 + white() * Math.exp(-t * 500) * 0.3) * 1.4);
  }, { gain: 0.78 * g });
  sidechain(t0, 0.62 * Math.min(1, g));
}
function sub(t0, g = 1, len = 2.2, f0 = 34) {
  let ph = 0;
  voice(t0, len, (t) => {
    ph += (TAU * (f0 + 80 * Math.exp(-t * 9))) / SR;
    return Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-t * (2.6 / len) * 2) * Math.min(1, t / 0.003);
  }, { gain: 0.7 * g });
}
function clap(t0, g = 1, pan = 0) {
  const bp = biquad("bp");
  voice(t0, 0.4, (t) => {
    let e = 0;
    for (const o of [0, 0.011, 0.023]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) * 150));
    if (t > 0.023) e = Math.max(e, 0.6 * Math.exp(-(t - 0.023) * 15));
    return bp(white(), 1350, 0.8) * e * 2.4;
  }, { gain: 0.36 * g, pan, rev: 0.32 });
}
function hat(t0, g = 1, open = false, pan = 0) {
  const hp = biquad("hp"), hp2 = biquad("hp");
  const fs = [263, 400, 421, 474, 587, 845];
  const ph = fs.map(() => R());
  voice(t0, open ? 0.4 : 0.09, (t) => {
    let m = 0;
    fs.forEach((f, i) => { ph[i] += (f * 1.9) / SR; m += (ph[i] % 1) < 0.5 ? 1 : -1; });
    const x = m * 0.12 + white() * 0.7;
    return hp2(hp(x, 7200, 0.8), 7200, 0.8) * Math.exp(-t * (open ? 9 : 62));
  }, { gain: 0.16 * g, pan, rev: open ? 0.08 : 0.02 });
}
function saw(ph) { return 2 * (ph % 1) - 1; }
function bass(t0, len, f) {
  const lp = biquad("lp");
  let p1 = 0, p2 = 0, p3 = 0;
  voice(t0, len + 0.05, (t) => {
    p1 += f / SR; p2 += (f * 1.006) / SR; p3 += (f / 2) / SR;
    const env = Math.min(1, t / 0.004) * (t < len ? 0.75 + 0.25 * Math.exp(-t * 18) : Math.exp(-(t - len) * 60));
    const x = lp(saw(p1) + saw(p2), 150 + 1500 * Math.exp(-t * 16), 1.1);
    return (x * 0.55 + Math.sin(TAU * p3) * 0.55) * env;
  }, { gain: 0.34, bus: music });
}
function pad(t0, len, notes, g = 1, att = 0.35, rel = 0.8) {
  notes.forEach((n, j) => {
    for (const side of [-1, 1]) {
      const lp = biquad("lp");
      const det = [0, 0.0045 * side, -0.0031 * side];
      const ph = det.map(() => R());
      const f = note(n);
      voice(t0, len + rel, (t) => {
        let x = 0;
        det.forEach((d, i) => { ph[i] += (f * (1 + d)) / SR; x += saw(ph[i]); });
        const env = Math.min(1, t / att) * (t > len ? Math.exp(-(t - len) * (4 / rel)) : 1);
        return lp(x / 3, 900 + 500 * Math.sin(t * 1.3 + j), 0.7) * env;
      }, { gain: (0.05 * g) / Math.sqrt(notes.length), pan: side * 0.65, rev: 0.35, bus: music });
    }
  });
}
function stab(t0, notes, g = 1) {
  notes.forEach((n, j) => {
    const lp = biquad("lp");
    const f = note(n);
    let a = R(), b = R();
    voice(t0, 0.9, (t) => {
      a += f / SR; b += (f * 1.008) / SR;
      return lp(saw(a) + saw(b), 400 + 5200 * Math.exp(-t * 9), 1.2) * Math.exp(-t * 5.5) * Math.min(1, t / 0.002);
    }, { gain: (0.2 * g) / Math.sqrt(notes.length), pan: (j / (notes.length - 1 || 1) - 0.5) * 0.9, rev: 0.4 });
  });
}
function pluck(t0, n, g = 1, pan = 0, decay = 7) {
  const f = note(n);
  let ph = 0;
  voice(t0, 1.2, (t) => {
    ph += (TAU * f) / SR;
    return Math.sin(ph + 1.2 * Math.exp(-t * 14) * Math.sin(ph * 2)) * Math.exp(-t * decay) * Math.min(1, t / 0.001);
  }, { gain: 0.13 * g, pan, rev: 0.32 });
}
function crash(t0, g = 1, len = 2.5) {
  for (const pan of [-0.5, 0.5]) {
    const hp = biquad("hp");
    voice(t0, len, (t) => hp(white(), 4200, 0.6) * Math.exp(-t * (5 / len)) * Math.min(1, t / 0.002), { gain: 0.14 * g, pan, rev: 0.25 });
  }
}
function whoosh(t0, len, f0, f1, g = 1, p0 = 0, p1 = 0) {
  const bp = biquad("bp"), lp = biquad("lp");
  voice(t0, len, (t) => {
    const u = t / len;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 2);
    const f = expLerp(f0, f1, u);
    return (bp(white(), f, 1.6) * 1.6 + lp(white(), f * 0.5, 0.7) * 0.5) * env;
  }, { gain: 0.3 * g, pan: (t) => p0 + (p1 - p0) * (t / len), rev: 0.18 });
}
function riser(t0, len, g = 1, f0 = 400, f1 = 8000) {
  const bp = biquad("bp");
  let ph = 0;
  voice(t0, len, (t) => {
    const u = t / len;
    ph += (TAU * expLerp(180, 1500, u)) / SR;
    return (bp(white(), expLerp(f0, f1, u), 2.2) * 1.4 + Math.sin(ph) * 0.18) * Math.pow(u, 2.2);
  }, { gain: 0.32 * g, rev: 0.2 });
}
function tick(t0, g = 1, f = 2400, pan = 0) {
  const hp = biquad("hp");
  let ph = 0;
  voice(t0, 0.05, (t) => {
    ph += (TAU * f) / SR;
    return hp(white(), 2800, 0.7) * Math.exp(-t * 520) + Math.sin(ph) * Math.exp(-t * 320) * 0.35;
  }, { gain: 0.2 * g, pan, rev: 0.05 });
}
function thock(t0, g = 1) {
  const lp = biquad("lp");
  let ph = 0;
  voice(t0, 0.25, (t) => {
    ph += (TAU * (150 + 60 * Math.exp(-t * 40))) / SR;
    return Math.sin(ph) * Math.exp(-t * 26) + lp(white(), 1400, 0.7) * Math.exp(-t * 70) * 0.8;
  }, { gain: 0.42 * g, rev: 0.1 });
}
function glitch(t0, len = 0.07, g = 1) {
  let held = 0;
  voice(t0, len, (t) => {
    if (Math.floor(t * 1800) !== Math.floor((t - 1 / SR) * 1800)) held = white();
    return held * (1 - t / len);
  }, { gain: 0.1 * g });
}
function sweep(t0, len, f0, f1, g = 1, p0 = 0, p1 = 0) {
  let ph = 0;
  voice(t0, len, (t) => {
    const u = t / len;
    ph += (TAU * expLerp(f0, f1, u)) / SR;
    return Math.sin(ph) * Math.sin(Math.PI * u);
  }, { gain: 0.07 * g, pan: (t) => p0 + (p1 - p0) * (t / len), rev: 0.3 });
}
function bell(t0, n, g = 1) {
  const f = note(n);
  const parts = [[1, 1, 1.6], [2.0, 0.45, 2.4], [2.76, 0.3, 3.2], [3.9, 0.18, 4.5], [5.4, 0.1, 6]];
  const ph = parts.map(() => 0);
  voice(t0, 3, (t) => {
    let x = 0;
    parts.forEach(([r, a, d], i) => { ph[i] += (TAU * f * r) / SR; x += Math.sin(ph[i]) * a * Math.exp(-t * d); });
    return x * Math.min(1, t / 0.002);
  }, { gain: 0.1 * g, rev: 0.5 });
}

/* score ------------------------------------------------------------------ */
// F minor. MIDI: F2=41 Ab2=44 C3=48 Db3=49 Eb3=51 F3=53 G3=55 Ab3=56 Bb3=58 C4=60 Eb4=63 F4=65
const chords = [
  [41, 48, 56, 60], [53, 56, 60, 63], [53, 56, 60, 63, 67], [49, 53, 56, 60, 63],
  [44, 56, 60, 63, 67], [51, 55, 58, 65], [53, 56, 60, 63], [37, 49, 53, 56, 60, 63],
];
const roots = [41, 41, 41, 37, 44, 39, 41, 37];

// 1 · mark
pluck(0.05, 84, 0.8, 0, 12);
sweep(0.05, 0.25, 1400, 900, 0.8);
pad(0.2, bt(4) - 0.2, chords[0], 1.4, 0.8, 0.4);
riser(bt(0.5), bt(0.5), 0.35, 300, 2000);
whoosh(bt(1) - 0.04, 0.36, 700, 5200, 0.8, -0.6, 0.6);
kick(bt(1) + 0.02, 0.45);
glitch(bt(1) + 0.03, 0.04, 0.6);
whoosh(bt(2) - 0.05, 0.3, 900, 6000, 0.9, 0.6, -0.6);
kick(bt(2) + 0.03, 1.1);
sub(bt(2) + 0.03, 0.9, 2.2);
crash(bt(2) + 0.03, 0.55, 2.4);
glitch(bt(2) + 0.03, 0.09, 1);
bell(bt(2) + 0.04, 77, 0.6);
whoosh(bt(2.5), 0.45, 250, 1200, 0.5, -0.3, 0.3);
riser(bt(3.1), bt(0.9), 0.9, 500, 11000);
whoosh(bt(3.4), bt(0.6), 300, 7000, 0.6, 0, 0);

// 2 · they said it
[0, 1, 2].forEach((i) => {
  kick(bt(4 + i), 1);
  sub(bt(4 + i), 0.35, 0.5, 40);
  stab(bt(4 + i), [[53, 56, 60, 63], [56, 60, 63, 65], [60, 63, 65, 68]][i], 1);
});
pad(bt(4), bt(4), chords[1], 0.6, 0.2, 0.2);
whoosh(bt(7) - 0.05, 0.32, 1200, 7000, 1, -0.8, 0.8);
whoosh(bt(7.5) - 0.05, 0.3, 1000, 6500, 0.9, 0.8, -0.8);
for (let k = 0; k < 8; k++) clap(bt(6 + k * 0.25), 0.15 + k * 0.05, 0);
for (let k = 0; k < 8; k++) clap(bt(7 + k * 0.125), 0.35 + k * 0.07, (k % 2 ? 0.2 : -0.2));
riser(bt(6.5), bt(1.5), 0.7, 400, 9000);

// groove, bars 3–7
for (let b = 8; b <= 26; b++) kick(bt(b), 1);
for (let b = 9; b <= 25; b += 2) clap(bt(b), 1);
for (let s = bt(8); s < bt(27) - 0.01; s += B / 4) {
  const k = Math.round((s - bt(8)) / (B / 4)) % 4;
  hat(s, [0.35, 0.22, 0.75, 0.22][k], false, k % 2 ? 0.25 : -0.2);
}
for (let b = 16; b < 27; b++) hat(bt(b + 0.5), 0.55, true, 0.1);
for (let b = 8; b < 27; b++)
  for (const o of [0.5]) bass(bt(b + o), B * 0.42, note(roots[Math.floor(b / 4)]));
for (let bar = 2; bar <= 6; bar++) pad(bt(bar * 4), bt(bar === 6 ? 3 : 4), chords[bar], 1, 0.25, 0.4);
// arp over bars 6–7
for (let s = 0; s < 28; s++) {
  const b = 20 + s * 0.25, ch = chords[Math.floor(b / 4)];
  pluck(bt(b), ch[s % ch.length] + 24, 0.35, s % 2 ? 0.45 : -0.45, 11);
}

// 3 · search
kick(bt(8), 0.4);
sub(bt(8), 0.7, 1.6);
crash(bt(8), 0.45, 2.2);
whoosh(bt(9.7), 0.55, 400, 2400, 0.35, 0, 0);
sweep(bt(9.9), 0.5, 900, 3200, 0.8, -0.5, 0.5);
for (let k = 0; k < 20; k++) tick(bt(10.5) + (k * B) / 8, 0.9, 2000 + ((k * 7) % 5) * 180, -0.2 + (k / 20) * 0.4);
thock(bt(13), 1);
bell(bt(13) + 0.01, 89, 0.35);
[65, 68, 70, 72, 75].forEach((n, i) => pluck(bt(13.45) + (i * B) / 4, n + 12, 0.7, -0.3 + i * 0.15));
whoosh(bt(15.3), 0.62, 350, 7500, 1.1, 0.8, -0.8);

// 4 · import
sub(bt(16) + 0.02, 0.4, 0.6, 38);
const io = (() => { // same cubic-bezier(.65,0,.35,1) the scan uses
  const s = (u, a, b) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  return (x) => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (s(m, 0.65, 0.35) < x) lo = m; else hi = m; } return s(lo, 0, 1); };
})();
const [a4, b4] = [bt(16.55), bt(19.2)];
const years = [75, 72, 70, 68, 65, 63, 60, 58, 56, 53, 51, 48, 46, 44];
years.forEach((n, y) => {
  const target = (y + 1) / 14;
  let lo = a4, hi = b4;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (io((m - a4) / (b4 - a4)) < target) lo = m; else hi = m; }
  pluck(lo, n, 0.6, 0.6 - (y / 13) * 1.2, 9);
  tick(lo, 0.35, 3200, 0.6 - (y / 13) * 1.2);
});
pluck(bt(19.2), 72, 0.9, 0, 5);
pluck(bt(19.2) + 0.08, 77, 0.9, 0, 4);
sweep(bt(19.6), bt(0.75), 1500, 420, 1.2, 0.4, -0.5);

// 5 · read
tick(bt(21), 1.4, 1500, -0.3);
tick(bt(21) + 0.07, 0.8, 1300, -0.3);
sweep(bt(21.05), 0.35, 600, 2200, 0.9, -0.3, 0.3);
whoosh(bt(21.25), 0.24, 700, 3800, 0.55, 0.2, 0.6);
for (const [n, d] of [[89, 0], [92, 0.09], [96, 0.19]]) {
  let ph = 0;
  voice(bt(22) + d, bt(23.4) - bt(22), (t) => { ph += (TAU * note(n)) / SR; return Math.sin(ph) * (0.6 + 0.4 * Math.sin(t * TAU * 12)) * Math.sin(Math.PI * t / (bt(23.4) - bt(22))); }, { gain: 0.022, rev: 0.5, pan: 0.4 });
}
whoosh(bt(23.4), bt(1), 1400, 220, 0.7, -0.5, 0.5);

// 6 · wall
{
  let ph = 0;
  voice(bt(26), bt(1), (t) => { ph += (TAU * expLerp(90, 900, t / bt(1))) / SR; return saw(ph / TAU) * Math.pow(t / bt(1), 2); }, { gain: 0.05, rev: 0.2 });
}
for (let k = 0; k < 8; k++) clap(bt(26 + k * 0.125), 0.3 + k * 0.08, k % 2 ? 0.25 : -0.25);
riser(bt(26), bt(2), 1, 300, 12000);
{
  const lp = biquad("lp");
  voice(bt(27), bt(1), (t) => { const u = t / bt(1); return lp(white(), expLerp(200, 12000, u), 0.8) * Math.pow(u, 3); }, { gain: 0.5, rev: 0.1 });
}
pad(bt(27), bt(1), chords[7].map((n) => n + 12), 1.2, bt(1) * 0.95, 0.01);

// 7 · wordmark
kick(bt(28), 1.25);
sub(bt(28), 1.1, 3, 32);
crash(bt(28), 0.7, 3.2);
stab(bt(28), chords[7], 1.2);
bell(bt(28) + 0.01, 77, 1);
[84, 89, 92, 96, 101].forEach((n, i) => pluck(bt(28.25) + i * 0.05, n, 0.5, -0.5 + i * 0.25, 6));
pad(bt(28), 15 - bt(28) - 0.3, chords[7], 1.3, 0.05, 0.4);
bass(bt(28), 15 - bt(28) - 0.3, note(37));
whoosh(bt(29.1), 0.5, 500, 2500, 0.3, -0.3, 0.3);
sub(bt(31), 0.4, 0.7, 45);
pluck(bt(31), 89, 0.5, 0, 5);

/* mix -------------------------------------------------------------------- */
function freeverb(inp) {
  const s = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ buf: new Float32Array(Math.round(d * s)), i: 0, f: 0 }));
  const aps = [556, 441, 341, 225].map((d) => ({ buf: new Float32Array(Math.round(d * s)), i: 0 }));
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const x = inp[n] * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.f = o * 0.75 + c.f * 0.25;
      c.buf[c.i] = x + c.f * 0.86;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of aps) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = o - y;
    }
    out[n] = y;
  }
  return out;
}
const wet = [freeverb(verb[0]), freeverb(verb[1].map((v, i, a) => a[Math.max(0, i - 23)]))];
const out = [new Float32Array(N), new Float32Array(N)];
let peak = 0;
for (let c = 0; c < 2; c++) {
  const hp = biquad("hp");
  for (let i = 0; i < N; i++) {
    let x = main[c][i] + music[c][i] * duck[i] + wet[c][i] * 1.1;
    x = hp(x, 28, 0.7);
    x = Math.tanh(x * 1.15) / 1.15;
    const t = i / SR;
    x *= Math.min(1, t / 0.004) * clamp((DUR - t) / 0.45);
    out[c][i] = x;
    peak = Math.max(peak, Math.abs(x));
  }
}
const norm = 0.89 / peak;
const wav = Buffer.alloc(44 + N * 4);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++)
  for (let c = 0; c < 2; c++) wav.writeInt16LE(Math.round(clamp(out[c][i] * norm, -1, 1) * 32767), 44 + i * 4 + c * 2);
const file = process.argv[2] ?? "reel.wav";
writeFileSync(file, wav);
console.log(file, `peak ${peak.toFixed(3)} → normalized`);

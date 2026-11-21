'use strict';
// Client-side image pipeline. Everything here prepares a 4bpp Spectra 6 frame
// (two pixels per byte, high nibble = left pixel) that the firmware writes to SD
// and then straight to the panel, so the preview is byte-for-byte what the frame
// will show.

const W = 800, H = 480;
const FRAME_BYTES = (W * H) / 2;
const DEFAULT_ASPECT = W / H;
const MAX_SRC_SIDE = 2000;   // loaded photos are resampled to this longest side

// Colour codes are the GxEPD2 "logical" 7-colour codes: the firmware feeds them
// to GxEPD2, which maps them to the panel's native Spectra 6 values.
const PALETTE = [
  { code: 0x0, r: 0,   g: 0,   b: 0,   name: 'чёрный' },
  { code: 0x1, r: 255, g: 255, b: 255, name: 'белый' },
  { code: 0x2, r: 0,   g: 255, b: 0,   name: 'зелёный' },
  { code: 0x3, r: 0,   g: 0,   b: 255, name: 'синий' },
  { code: 0x4, r: 255, g: 0,   b: 0,   name: 'красный' },
  { code: 0x5, r: 255, g: 255, b: 0,   name: 'жёлтый' },
];
const BY_CODE = {};
for (const p of PALETTE) BY_CODE[p.code] = p;

// --- adjustment catalogue ---------------------------------------------------

const GROUPS = [
  { id: 'tone', label: 'Тон' },
  { id: 'color', label: 'Цвет' },
  { id: 'detail', label: 'Детали' },
];

const ADJUSTMENTS = [
  { key: 'exposure',   group: 'tone',   label: 'Экспозиция',     min: -100, max: 100, unit: '%' },
  { key: 'brightness', group: 'tone',   label: 'Яркость',        min: -100, max: 100, unit: '%' },
  { key: 'contrast',   group: 'tone',   label: 'Контраст',       min: -100, max: 100, unit: '%' },
  { key: 'blacks',     group: 'tone',   label: 'Чёрный уровень', min: 0,    max: 90,  unit: '%' },
  { key: 'whites',     group: 'tone',   label: 'Белый уровень',  min: 10,   max: 100, def: 100, unit: '%' },
  { key: 'gamma',      group: 'tone',   label: 'Гамма',          min: 30,   max: 300, def: 100, unit: '×', scale: 0.01 },
  { key: 'shadows',    group: 'tone',   label: 'Тени',           min: -100, max: 100, unit: '%' },
  { key: 'highlights', group: 'tone',   label: 'Света',          min: -100, max: 100, unit: '%' },
  { key: 'saturation', group: 'color',  label: 'Насыщенность',   min: -100, max: 100, unit: '%' },
  { key: 'gray',       group: 'color',  label: 'Обесцветить',    min: 0,    max: 100, unit: '%' },
  { key: 'hue',        group: 'color',  label: 'Переворот тона', min: -180, max: 180, unit: '°' },
  { key: 'temp',       group: 'color',  label: 'Температура',    min: -100, max: 100, unit: '', hints: ['холод', 'тепло'] },
  { key: 'tint',       group: 'color',  label: 'Оттеночный сдвиг', min: -100, max: 100, unit: '', hints: ['зелёный', 'пурпур'] },
  { key: 'sharpen',    group: 'detail', label: 'Резкость',       min: 0,    max: 100, unit: '%' },
  { key: 'blur',       group: 'detail', label: 'Размытие',       min: 0,    max: 40,  unit: ' px', scale: 0.1, digits: 1 },
  { key: 'vignette',   group: 'detail', label: 'Виньетка',       min: 0,    max: 100, unit: '%' },
];
const ADJ_BY_KEY = {};
for (const a of ADJUSTMENTS) ADJ_BY_KEY[a.key] = a;

const DEFAULT_ADJ = {};
for (const a of ADJUSTMENTS) DEFAULT_ADJ[a.key] = a.def || 0;

// Duotone / toning: luminance is mapped straight onto a two colour ramp, which is
// exactly how a six colour e-paper renders a tinted black-and-white photo.
const TONES = [
  { id: 'none',      label: 'Без тонирования' },
  { id: 'cool',      label: 'Холодный ч/б',     lo: [0, 0, 22],     hi: [238, 244, 255] },
  { id: 'warm',      label: 'Тёплый ч/б',       lo: [22, 12, 0],    hi: [255, 244, 222] },
  { id: 'sepia',     label: 'Сепия',            lo: [35, 20, 8],    hi: [255, 236, 186] },
  { id: 'blueprint', label: 'Синька',           lo: [0, 0, 45],     hi: [215, 230, 255] },
  { id: 'blackRed',  label: 'Чёрный → красный', lo: [0, 0, 0],      hi: [255, 0, 0] },
  { id: 'blackBlue', label: 'Чёрный → синий',   lo: [0, 0, 0],      hi: [0, 0, 255] },
  { id: 'blackGreen', label: 'Чёрный → зелёный', lo: [0, 0, 0],     hi: [0, 255, 0] },
  { id: 'blackYellow', label: 'Чёрный → жёлтый', lo: [0, 0, 0],     hi: [255, 255, 0] },
  { id: 'whiteBlue', label: 'Белый → синий',    lo: [0, 0, 255],    hi: [255, 255, 255] },
];
const TONE_BY_ID = {};
for (const t of TONES) TONE_BY_ID[t.id] = t;

// A preset is a whole look: sliders plus how it is reduced to panel colours.
const PRESETS = [
  { id: 'none', label: 'Оригинал' },
  { id: 'auto', label: 'Авторежим', adj: { contrast: 8, shadows: 10, highlights: -12, sharpen: 25, blacks: 2, whites: 99 } },
  { id: 'bw', label: 'Ч/Б фото', adj: { gray: 100, contrast: 8, shadows: 12, highlights: -6, sharpen: 22 }, palette: 'bw' },
  { id: 'bwHard', label: 'Ч/Б контраст', adj: { gray: 100, contrast: 34, blacks: 8, whites: 96, sharpen: 35 }, palette: 'bw', dither: 'atkinson' },
  { id: 'bwSoft', label: 'Ч/Б мягкий', adj: { gray: 100, contrast: -6, shadows: 16, highlights: 8 }, palette: 'bw', dither: 'bayer' },
  { id: 'print', label: 'Газетный плакат', adj: { gray: 100, contrast: 70, blacks: 18, whites: 88, sharpen: 40 }, palette: 'bw', dither: 'bayer' },
  { id: 'sepia', label: 'Сепия', tone: 'sepia', adj: { contrast: 8, sharpen: 18 } },
  { id: 'cool', label: 'Холодная плёнка', tone: 'cool', adj: { contrast: 10, shadows: 8 } },
  { id: 'warm', label: 'Тёплая плёнка', tone: 'warm', adj: { contrast: 8, highlights: -8 } },
  { id: 'duoRed', label: 'Чёрно-красный', tone: 'blackRed', colors: [0x0, 0x4], adj: { contrast: 14, sharpen: 20 } },
  { id: 'duoBlue', label: 'Чёрно-синий', tone: 'blackBlue', colors: [0x0, 0x3], adj: { contrast: 14, sharpen: 20 } },
  { id: 'neon', label: 'Жёлтый по чёрному', tone: 'blackYellow', colors: [0x0, 0x5], adj: { contrast: 26, blacks: 6 } },
  { id: 'invert', label: 'Инверсия', invert: true },
];

const DITHER_MODES = {
  none: null,
  fs: { div: 16, cells: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, cells: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [2, 1, 1]] },
  burkes: { div: 32, cells: [[1, 0, 8], [2, 0, 8], [-2, 1, 4], [-1, 1, 4], [0, 1, 4], [1, 1, 4], [2, 1, 4]] },
};

// 8x8 Bayer matrix, built recursively to keep the source small.
const BAYER = (() => {
  let m = [[0]], n = 1;
  while (n < 8) {
    const next = [];
    for (let y = 0; y < n * 2; y++) next.push(new Array(n * 2).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 4 * m[y][x];
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
    n *= 2;
  }
  return m;
})();

// --- dom helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const toastEl = $('toast');
const gallery = $('gallery');
const editCanvas = $('editCanvas');
const editCtx = editCanvas.getContext('2d');
const previewCanvas = $('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');
const detailCanvas = $('detailCanvas');
const detailCtx = detailCanvas.getContext('2d');

const base = document.createElement('canvas');
const baseCtx = base.getContext('2d');
const out = document.createElement('canvas');
out.width = W; out.height = H;
const outCtx = out.getContext('2d', { willReadFrequently: true });

let scratchDiffuse = null;   // Float32Array used by error diffusion
let scratchBlurA = null;     // two working buffers for the separable blur
let scratchBlurB = null;

const state = {
  item: null,        // queue entry being edited
  image: null,       // ImageBitmap | HTMLImageElement | HTMLCanvasElement
  rotation: 0,
  flipH: false,
  flipV: false,
  aspect: DEFAULT_ASPECT,
  sel: { x: 0, y: 0, w: 1, h: 1 },
  adj: { ...DEFAULT_ADJ },
  tone: 'none',
  invert: false,
  paletteMode: 'color',
  colors: new Set(PALETTE.map((p) => p.code)),
  dither: 'fs',
  scale: 1,
  drag: null,
  codes: null,
  compare: false,
  renderQueued: false,
};

function toast(msg, ms = 2500, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// Preferences that should survive a reload: which accordions were open, etc.
function storageGet(key) {
  try { return localStorage.getItem('eink.' + key); } catch (err) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem('eink.' + key, value); } catch (err) { /* private mode */ }
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
  if (n > 1024) return (n / 1024).toFixed(0) + ' КБ';
  return n + ' Б';
}

function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU') + ' ' +
         d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function nowMs() {
  return (window.performance && performance.now) ? performance.now() : Date.now();
}

// Cyrillic names make perfectly good titles, but the file stem stays ASCII, so
// the slug is a transliteration of what the user typed.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'e', ў: 'u', џ: 'dz', ћ: 'c', ђ: 'dj', ј: 'j',
};

function slugify(text) {
  let s = String(text || '').toLowerCase();
  s = s.split('').map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  s = s.replace(/-+$/g, '');
  return s || 'photo';
}

function stripExtension(name) {
  return String(name || '').replace(/\.[^.]{1,8}$/, '').trim();
}

function srcSize(el) {
  if (el.naturalWidth) return { w: el.naturalWidth, h: el.naturalHeight };
  return { w: el.width, h: el.height };
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let json = {};
  try { json = await res.json(); } catch (err) { /* empty or non-json reply */ }
  if (!res.ok || json.ok === false) throw new Error(json.error || 'запрос не прошёл');
  return json;
}

// --- colour quantisation ----------------------------------------------------

function activeColors() {
  if (state.paletteMode === 'bw') return [BY_CODE[0x0], BY_CODE[0x1]];
  if (state.paletteMode === 'custom') {
    const list = PALETTE.filter((p) => state.colors.has(p.code));
    if (list.length) return list;
  }
  return PALETTE;
}

function nearestColor(palette, r, g, b) {
  let best = palette[0], bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p.r, dg = g - p.g, db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function quantize(rgba, palette, dither) {
  const codes = new Uint8Array(W * H);
  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

  if (dither === 'bayer') {
    // Ordered dithering: perturb every pixel by its matrix slot, then round to
    // the nearest colour. Cheap and stable, leaves a regular pattern.
    const spread = palette.length > 2 ? 80 : 170;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        const t = (BAYER[y & 7][x & 7] + 0.5) / 64 - 0.5;
        codes[y * W + x] = nearestColor(palette,
          clamp(rgba[k] + t * spread),
          clamp(rgba[k + 1] + t * spread),
          clamp(rgba[k + 2] + t * spread)).code;
      }
    }
    return codes;
  }

  const kernel = DITHER_MODES[dither];
  if (!kernel) {
    for (let i = 0, n = W * H; i < n; i++) {
      const k = i * 4;
      codes[i] = nearestColor(palette, rgba[k], rgba[k + 1], rgba[k + 2]).code;
    }
    return codes;
  }

  const len = W * H * 4;
  if (!scratchDiffuse || scratchDiffuse.length < len) scratchDiffuse = new Float32Array(len);
  const buf = scratchDiffuse;
  for (let i = 0; i < len; i++) buf[i] = rgba[i];

  const cells = kernel.cells, div = kernel.div;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const r = clamp(buf[k]), g = clamp(buf[k + 1]), b = clamp(buf[k + 2]);
      const p = nearestColor(palette, r, g, b);
      codes[y * W + x] = p.code;
      const er = r - p.r, eg = g - p.g, eb = b - p.b;
      for (let c = 0; c < cells.length; c++) {
        const nx = x + cells[c][0], ny = y + cells[c][1];
        if (nx < 0 || nx >= W || ny >= H) continue;
        const nk = (ny * W + nx) * 4;
        const w = cells[c][2] / div;
        buf[nk] += er * w; buf[nk + 1] += eg * w; buf[nk + 2] += eb * w;
      }
    }
  }
  return codes;
}

function packCodes(codes) {
  const bytes = new Uint8Array(FRAME_BYTES);
  const row = W / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x += 2) {
      bytes[y * row + x / 2] = (codes[y * W + x] << 4) | codes[y * W + x + 1];
    }
  }
  return bytes;
}

function unpackFrame(bytes) {
  const codes = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const byte = bytes[i >> 1];
    codes[i] = (i & 1) ? (byte & 0x0f) : (byte >> 4);
  }
  return codes;
}

function paintCodes(ctx, codes) {
  const img = new ImageData(W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    const p = BY_CODE[codes[i]] || BY_CODE[0x1];
    const k = i * 4;
    d[k] = p.r; d[k + 1] = p.g; d[k + 2] = p.b; d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function drawRawToCanvas(canvas, bytes) {
  paintCodes(canvas.getContext('2d'), unpackFrame(bytes));
}

// --- toning and colour correction -------------------------------------------

function buildLut(adj) {
  const lo = adj.blacks * 2.55;
  const hi = Math.max(lo + 8, adj.whites * 2.55);
  const gain = Math.pow(2, adj.exposure / 100);
  const c = adj.contrast * 1.28;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const add = adj.brightness * 1.28;
  const invGamma = 100 / Math.max(30, adj.gamma);
  const lut = new Uint8Array(256);
  let identity = true;
  for (let x = 0; x < 256; x++) {
    let v = (x - lo) * (255 / (hi - lo));
    v = v * gain;
    v = (v - 128) * cf + 128;
    v = v + add;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    v = 255 * Math.pow(v / 255, invGamma);
    const q = Math.round(v < 0 ? 0 : v > 255 ? 255 : v);
    lut[x] = q;
    if (q !== x) identity = false;
  }
  return identity ? null : lut;
}

function buildToneLuts(toneId) {
  const t = TONE_BY_ID[toneId];
  if (!t || !t.lo) return null;
  const luts = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  for (let l = 0; l < 256; l++) {
    const f = l / 255;
    for (let ch = 0; ch < 3; ch++) luts[ch][l] = t.lo[ch] + (t.hi[ch] - t.lo[ch]) * f;
  }
  return luts;
}

// Same matrix the CSS hue-rotate filter uses.
function hueMatrix(deg) {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
}

function applyLook(data, adj, toneId, invert) {
  const lut = buildLut(adj);
  const toneLuts = buildToneLuts(toneId);
  const doSh = adj.shadows !== 0 || adj.highlights !== 0;
  const doTemp = adj.temp !== 0;
  const doTint = adj.tint !== 0;
  const doHue = adj.hue !== 0;
  const satFactor = (1 - adj.gray / 100) * (1 + adj.saturation / 100);
  const doSat = satFactor !== 1;
  const m = doHue ? hueMatrix(adj.hue) : null;
  const shK = adj.shadows / 100 * 0.5;
  const hiK = adj.highlights / 100 * 0.5;
  const temp = adj.temp / 100;
  const tint = adj.tint / 100;

  if (!lut && !toneLuts && !doSh && !doTemp && !doTint && !doHue && !doSat && !invert) return;

  for (let i = 0, k = 0; i < W * H; i++, k += 4) {
    let r = data[k], g = data[k + 1], b = data[k + 2];
    if (lut) { r = lut[r]; g = lut[g]; b = lut[b]; }

    if (doSh) {
      const ln = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const lift = ln + shK * Math.pow(1 - ln, 2.2) + hiK * Math.pow(ln, 2.2);
      const f = lift / (ln < 0.004 ? 0.004 : ln);
      r *= f; g *= f; b *= f;
    }
    if (doTemp) {
      r *= 1 + 0.20 * temp;
      b *= 1 - 0.20 * temp;
      g *= 1 - 0.03 * Math.abs(temp);
    }
    if (doTint) {
      g *= 1 - 0.16 * tint;
      r *= 1 + 0.08 * tint;
      b *= 1 + 0.08 * tint;
    }
    if (doHue) {
      const nr = m[0] * r + m[1] * g + m[2] * b;
      const ng = m[3] * r + m[4] * g + m[5] * b;
      const nb = m[6] * r + m[7] * g + m[8] * b;
      r = nr; g = ng; b = nb;
    }
    if (doSat) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * satFactor;
      g = luma + (g - luma) * satFactor;
      b = luma + (b - luma) * satFactor;
    }
    if (toneLuts) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const l = luma < 0 ? 0 : luma > 255 ? 255 : luma | 0;
      r = toneLuts[0][l]; g = toneLuts[1][l]; b = toneLuts[2][l];
    }
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }

    data[k] = r; data[k + 1] = g; data[k + 2] = b;
  }
}

function ensureBlurScratch() {
  if (!scratchBlurA) {
    scratchBlurA = new Uint8ClampedArray(W * H * 4);
    scratchBlurB = new Uint8ClampedArray(W * H * 4);
  }
}

// Separable box blur over RGB; alpha is forced opaque.
function blurInto(src, dst, r) {
  const tmp = scratchBlurB;
  const win = r * 2 + 1;
  const clX = (x) => x < 0 ? 0 : x >= W ? W - 1 : x;
  const clY = (y) => y < 0 ? 0 : y >= H ? H - 1 : y;

  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + clX(x) * 4 + ch];
      for (let x = 0; x < W; x++) {
        tmp[row + x * 4 + ch] = sum / win;
        sum -= src[row + clX(x - r) * 4 + ch];
        sum += src[row + clX(x + r + 1) * 4 + ch];
      }
    }
  }
  for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[clY(y) * W * 4 + x * 4 + ch];
      for (let y = 0; y < H; y++) {
        dst[(y * W + x) * 4 + ch] = sum / win;
        sum -= tmp[clY(y - r) * W * 4 + x * 4 + ch];
        sum += tmp[clY(y + r + 1) * W * 4 + x * 4 + ch];
      }
    }
    for (let y = 0; y < H; y++) dst[(y * W + x) * 4 + 3] = 255;
  }
}

function applySpatial(data, adj) {
  const blurR = Math.round(adj.blur / 10);
  if (!blurR && !adj.sharpen) return;
  ensureBlurScratch();

  if (blurR) {
    blurInto(data, scratchBlurA, blurR);
    data.set(scratchBlurA);
  }
  if (adj.sharpen) {
    const r = 1 + Math.round(adj.sharpen / 40);
    blurInto(data, scratchBlurA, r);
    const amount = adj.sharpen / 100 * 1.5;
    for (let k = 0; k < W * H * 4; k += 4) {
      data[k] += (data[k] - scratchBlurA[k]) * amount;
      data[k + 1] += (data[k + 1] - scratchBlurA[k + 1]) * amount;
      data[k + 2] += (data[k + 2] - scratchBlurA[k + 2]) * amount;
    }
  }
}

function applyVignette(data, amount) {
  if (!amount) return;
  const k = amount / 100 * 0.95;
  let idx = 0;
  for (let y = 0; y < H; y++) {
    const dy = ((y + 0.5) / H) * 2 - 1;
    for (let x = 0; x < W; x++, idx += 4) {
      const dx = ((x + 0.5) / W) * 2 - 1;
      let d = Math.sqrt((dx * dx + dy * dy) / 2);
      d = (d - 0.55) / 0.45;
      if (d <= 0) continue;
      if (d > 1) d = 1;
      const f = 1 - k * d * d;
      data[idx] *= f; data[idx + 1] *= f; data[idx + 2] *= f;
    }
  }
}

// --- rendering --------------------------------------------------------------

function renderFrame() {
  clearTimeout(preview.timer);
  preview.timer = null;
  state.renderQueued = false;
  if (!state.image) return null;
  const t0 = nowMs();
  const s = state.sel;
  outCtx.fillStyle = '#fff';
  outCtx.fillRect(0, 0, W, H);
  outCtx.drawImage(base, s.x, s.y, s.w, s.h, 0, 0, W, H);
  const data = outCtx.getImageData(0, 0, W, H).data;

  if (!state.compare) {
    applyLook(data, state.adj, state.tone, state.invert);
    applySpatial(data, state.adj);
    applyVignette(data, state.adj.vignette);
  }
  state.codes = quantize(data, activeColors(), state.dither);
  paintCodes(previewCtx, state.codes);
  setStale(false);
  $('previewInfo').textContent = Math.round(nowMs() - t0) + ' мс';
  return state.codes;
}

// --- preview scheduling -----------------------------------------------------
// Quantising 800x480 is the expensive part (tens of ms on a desktop, a few
// hundred on a phone), so the preview is not recalculated on every slider tick.
// Changes only mark it stale; the user refreshes it explicitly, or turns on
// "Авто", which coalesces a burst of events into one debounced render.

const preview = { stale: false, auto: false, timer: null };

function setStale(stale) {
  preview.stale = stale;
  const button = $('refreshPreview');
  if (button) button.hidden = !stale;
  const info = $('previewInfo');
  if (info) info.classList.toggle('stale', !!stale);
  if (stale && info) info.textContent = 'превью устарело';
}

function markStale() {
  setStale(true);
  if (preview.auto) scheduleRender(400);
}

function scheduleRender(delay) {
  clearTimeout(preview.timer);
  state.renderQueued = true;
  const run = () => {
    if (!state.renderQueued) return;
    state.renderQueued = false;
    renderFrame();
  };
  if (delay) preview.timer = setTimeout(run, delay);
  else requestAnimationFrame(run);
}

// --- editor: base image and crop overlay ------------------------------------

function rebuildBase(keepSel) {
  if (!state.image) return;
  const angle = ((state.rotation % 360) + 360) % 360;
  const size = srcSize(state.image);
  const swap = (angle === 90 || angle === 270);
  base.width = swap ? size.h : size.w;
  base.height = swap ? size.w : size.h;
  baseCtx.fillStyle = '#fff';
  baseCtx.fillRect(0, 0, base.width, base.height);
  baseCtx.save();
  baseCtx.translate(base.width / 2, base.height / 2);
  baseCtx.rotate(angle * Math.PI / 180);
  baseCtx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
  baseCtx.drawImage(state.image, -size.w / 2, -size.h / 2);
  baseCtx.restore();
  if (keepSel) clampSelection(); else resetSelection();
  layoutEditor();
  drawEditor();
  scheduleRender();
  $('editor').hidden = false;
}

function resetSelection() {
  const bw = base.width, bh = base.height;
  if (!state.aspect) {
    state.sel = { x: 0, y: 0, w: bw, h: bh };
    return;
  }
  let w = bw, h = bw / state.aspect;
  if (h > bh) { h = bh; w = bh * state.aspect; }
  state.sel = { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

function layoutEditor() {
  const panel = editCanvas.parentElement;
  // The panel head lives inside the padding, so its width is the real space a
  // canvas can take - more reliable than guessing the padding per breakpoint.
  const head = panel ? panel.querySelector('.panel-head') : null;
  const avail = head ? head.clientWidth : (panel ? panel.clientWidth - 32 : 720);
  if (avail <= 0) return;   // tab is hidden: keep the last real layout
  const maxW = Math.min(760, Math.max(240, avail));
  // On a phone the crop view must not push every control off the screen.
  const maxH = Math.max(200, Math.min(460, Math.round(window.innerHeight * 0.42)));
  layoutEditor.lastWidth = avail;
  const s = Math.min(maxW / base.width, maxH / base.height, 1);
  state.scale = s;
  editCanvas.width = Math.max(1, Math.round(base.width * s));
  editCanvas.height = Math.max(1, Math.round(base.height * s));
}

function selectionInView() {
  const s = state.scale;
  return { x: state.sel.x * s, y: state.sel.y * s, w: state.sel.w * s, h: state.sel.h * s };
}

function handlePoints(r) {
  const mx = r.x + r.w / 2, my = r.y + r.h / 2;
  const pts = {
    nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h],
  };
  if (!state.aspect) {
    pts.n = [mx, r.y]; pts.s = [mx, r.y + r.h]; pts.w = [r.x, my]; pts.e = [r.x + r.w, my];
  }
  return pts;
}

function drawEditor() {
  const cw = editCanvas.width, ch = editCanvas.height;
  editCtx.clearRect(0, 0, cw, ch);
  editCtx.drawImage(base, 0, 0, cw, ch);

  const r = selectionInView();
  editCtx.fillStyle = 'rgba(0,0,0,0.55)';
  editCtx.fillRect(0, 0, cw, r.y);
  editCtx.fillRect(0, r.y + r.h, cw, ch - (r.y + r.h));
  editCtx.fillRect(0, r.y, r.x, r.h);
  editCtx.fillRect(r.x + r.w, r.y, cw - (r.x + r.w), r.h);

  editCtx.strokeStyle = '#4f8cff';
  editCtx.lineWidth = 2;
  editCtx.strokeRect(r.x, r.y, r.w, r.h);

  if (state.aspect) {
    editCtx.lineWidth = 1;
    editCtx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 1; i <= 2; i++) {
      const gx = r.x + (r.w * i) / 3, gy = r.y + (r.h * i) / 3;
      editCtx.beginPath(); editCtx.moveTo(gx, r.y); editCtx.lineTo(gx, r.y + r.h); editCtx.stroke();
      editCtx.beginPath(); editCtx.moveTo(r.x, gy); editCtx.lineTo(r.x + r.w, gy); editCtx.stroke();
    }
  }

  const pts = handlePoints(r);
  editCtx.fillStyle = '#fff';
  editCtx.strokeStyle = '#4f8cff';
  editCtx.lineWidth = 2;
  for (const key in pts) {
    const [hx, hy] = pts[key];
    editCtx.beginPath();
    editCtx.rect(hx - 6, hy - 6, 12, 12);
    editCtx.fill();
    editCtx.stroke();
  }
}

function clampSelection() {
  const bw = base.width, bh = base.height;
  let { x, y, w, h } = state.sel;
  w = Math.max(24, w); h = Math.max(24, h);
  if (state.aspect) {
    if (w / h > state.aspect) w = h * state.aspect; else h = w / state.aspect;
    if (w > bw) { w = bw; h = w / state.aspect; }
    if (h > bh) { h = bh; w = h * state.aspect; }
  } else {
    w = Math.min(w, bw); h = Math.min(h, bh);
  }
  x = Math.max(0, Math.min(x, bw - w));
  y = Math.max(0, Math.min(y, bh - h));
  state.sel = { x, y, w, h };
}

function resizeSelection(mode, bx, by) {
  const o = state.drag.orig;
  const right = o.x + o.w, bottom = o.y + o.h;
  if (state.aspect) {
    let ax, ay;
    if (mode === 'nw') { ax = right; ay = bottom; }
    else if (mode === 'ne') { ax = o.x; ay = bottom; }
    else if (mode === 'se') { ax = o.x; ay = o.y; }
    else { ax = right; ay = o.y; }
    let w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (w / h > state.aspect) h = w / state.aspect; else w = h * state.aspect;
    state.sel = { x: bx < ax ? ax - w : ax, y: by < ay ? ay - h : ay, w, h };
  } else {
    let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
    if (mode.includes('w')) { nx = bx; nw = right - bx; }
    if (mode.includes('e')) { nw = bx - o.x; }
    if (mode.includes('n')) { ny = by; nh = bottom - by; }
    if (mode.includes('s')) { nh = by - o.y; }
    if (nw < 0) { nx += nw; nw = -nw; }
    if (nh < 0) { ny += nh; nh = -nh; }
    state.sel = { x: nx, y: ny, w: nw, h: nh };
  }
  clampSelection();
}

function pointerPos(ev) {
  const rect = editCanvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (editCanvas.width / rect.width),
    y: (ev.clientY - rect.top) * (editCanvas.height / rect.height),
  };
}

function pickHandle(p) {
  const r = selectionInView();
  const pts = handlePoints(r);
  for (const key in pts) {
    const [hx, hy] = pts[key];
    if (Math.abs(p.x - hx) <= 12 && Math.abs(p.y - hy) <= 12) return key;
  }
  if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return 'move';
  return null;
}

editCanvas.addEventListener('pointerdown', (ev) => {
  if (!state.image) return;
  const p = pointerPos(ev);
  const handle = pickHandle(p);
  if (!handle) return;
  ev.preventDefault();
  editCanvas.setPointerCapture(ev.pointerId);
  state.drag = { mode: handle, start: p, orig: { ...state.sel } };
});

editCanvas.addEventListener('pointermove', (ev) => {
  if (!state.drag) {
    const p = pointerPos(ev);
    const h = pickHandle(p);
    editCanvas.style.cursor = h === 'move' ? 'move' : (h ? h + '-resize' : 'crosshair');
    return;
  }
  const p = pointerPos(ev);
  const s = state.scale;
  if (state.drag.mode === 'move') {
    state.sel = {
      x: state.drag.orig.x + (p.x - state.drag.start.x) / s,
      y: state.drag.orig.y + (p.y - state.drag.start.y) / s,
      w: state.drag.orig.w, h: state.drag.orig.h,
    };
    clampSelection();
  } else {
    resizeSelection(state.drag.mode, p.x / s, p.y / s);
  }
  drawEditor();
  markStale();
});

function endDrag() {
  if (!state.drag) return;
  state.drag = null;
  captureItem();
  markStale();
}
editCanvas.addEventListener('pointerup', endDrag);
editCanvas.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => {
  if (!state.image) return;
  layoutEditor();
  drawEditor();
});

// Phone browsers settle the content width late (scrollbar, rotation, zoom), so
// the crop view is re-laid-out whenever the panel itself changes size.
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => {
    if (!state.image || state.drag) return;
    const head = editCanvas.parentElement && editCanvas.parentElement.querySelector('.panel-head');
    if (!head) return;
    if (Math.abs(head.clientWidth - (layoutEditor.lastWidth || 0)) > 3) {
      layoutEditor();
      drawEditor();
    }
  });
  observer.observe(editCanvas.parentElement);
}

// --- queue of selected photos ----------------------------------------------

let queue = [];
let uid = 0;

function currentEdit() {
  return {
    rotation: state.rotation,
    flipH: state.flipH,
    flipV: state.flipV,
    aspect: state.aspect,
    sel: state.sel ? { ...state.sel } : null,
    adj: { ...state.adj },
    tone: state.tone,
    invert: state.invert,
    paletteMode: state.paletteMode,
    colors: new Set(state.colors),
    dither: state.dither,
  };
}

function captureItem() {
  const item = state.item;
  if (!item) return;
  item.title = $('imgTitle').value;
  item.edit = currentEdit();
}

function activateItem(id) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  captureItem();
  state.item = item;
  const e = item.edit;
  state.image = item.img;
  state.rotation = e.rotation;
  state.flipH = e.flipH;
  state.flipV = e.flipV;
  state.aspect = e.aspect;
  state.adj = { ...e.adj };
  state.tone = e.tone;
  state.invert = e.invert;
  state.paletteMode = e.paletteMode;
  state.colors = new Set(e.colors);
  state.dither = e.dither;
  state.sel = e.sel ? { ...e.sel } : null;
  $('imgTitle').value = item.title || '';
  syncControls();
  rebuildBase(!!state.sel);
  renderQueue();
  updateNameHint();
}

function removeItem(id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return;
  const [item] = queue.splice(idx, 1);
  if (item.img && typeof item.img.close === 'function') item.img.close();
  const wasActive = state.item === item;
  if (wasActive) state.item = null;
  if (wasActive) {
    if (queue.length) activateItem(queue[Math.max(0, idx - 1)].id);
    else clearEditor();
  } else {
    renderQueue();
  }
}

function clearEditor() {
  state.image = null;
  state.codes = null;
  state.item = null;
  $('editor').hidden = true;
  $('drop').classList.remove('compact');
  $('saveAllBtn').hidden = true;
  $('saveCopyBtn').hidden = true;
  $('progress').hidden = true;
}

function scaleToCanvas(source, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

async function loadToItem(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // createImageBitmap applies the EXIF orientation, so the crop overlay and
      // the pixels agree from the start.
      let bmp = await createImageBitmap(file);
      const side = Math.max(bmp.width, bmp.height);
      if (side > MAX_SRC_SIDE) {
        const f = MAX_SRC_SIDE / side;
        const scaled = scaleToCanvas(bmp, Math.round(bmp.width * f), Math.round(bmp.height * f));
        bmp.close();
        bmp = await createImageBitmap(scaled);
      }
      return bmp;
    } catch (err) { /* fall back to <img> */ }
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.max(img.naturalWidth, img.naturalHeight);
      if (side <= MAX_SRC_SIDE) { resolve(img); return; }
      const f = MAX_SRC_SIDE / side;
      resolve(scaleToCanvas(img, Math.round(img.naturalWidth * f), Math.round(img.naturalHeight * f)));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('файл не открылся')); };
    img.src = url;
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || [])
    .filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name));
  if (!files.length) { toast('Это не похоже на картинку', 3000, true); return; }

  let firstNew = null, added = 0;
  for (const file of files) {
    let img;
    try {
      img = await loadToItem(file);
    } catch (err) {
      toast('Файл «' + file.name + '» не открылся', 3500, true);
      continue;
    }
    const item = {
      id: ++uid,
      file,
      img,
      title: stripExtension(file.name),
      slug: '',
      status: 'new',
      note: '',
      edit: currentEdit(),
    };
    item.edit.sel = null;
    queue.push(item);
    if (!firstNew) firstNew = item.id;
    added++;
  }
  if (!added) return;
  $('drop').classList.add('compact');
  activateItem(firstNew);
  toast(added > 1 ? 'Добавлено фото: ' + added : 'Фото готово — проверьте имя и кадр', 2500);
}

function renderQueue() {
  const list = $('queue');
  list.hidden = queue.length === 0;
  list.innerHTML = '';
  queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'q-item' + (state.item === item ? ' active' : '') +
                   (item.status === 'done' ? ' done' : '') +
                   (item.status === 'error' ? ' error' : '');

    const index = document.createElement('span');
    index.className = 'q-index';
    index.textContent = (i + 1) + '.';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'q-name';
    name.maxLength = 60;
    name.value = item.title || '';
    name.placeholder = 'имя фотографии';
    name.addEventListener('input', () => {
      item.title = name.value;
      if (state.item === item) { $('imgTitle').value = name.value; updateNameHint(); }
    });

    const file = document.createElement('span');
    file.className = 'q-file';
    file.textContent = item.file ? item.file.name : 'кадр с рамки';
    file.title = file.textContent;

    const size = document.createElement('span');
    size.className = 'q-size';
    size.textContent = item.file ? fmtBytes(item.file.size) : '192 КБ';

    const note = document.createElement('span');
    note.className = 'q-state';
    note.textContent = item.status === 'done' ? 'сохранено'
      : item.status === 'error' ? (item.note || 'ошибка')
      : (state.item === item ? 'редактируется' : 'ожидает');
    if (item.status === 'error') note.title = item.note || '';

    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Открыть';
    open.onclick = () => activateItem(item.id);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '✕';
    del.title = 'Убрать из очереди';
    del.onclick = () => removeItem(item.id);

    li.append(index, name, file, size, note, open, del);
    list.appendChild(li);
  });
  updateSaveAllLabel();
}

function updateSaveAllLabel() {
  const pending = queue.filter((q) => q.status !== 'done').length;
  const btn = $('saveAllBtn');
  btn.hidden = queue.length < 2;
  btn.textContent = 'Сохранить все (' + pending + ')';
  btn.disabled = pending === 0;
}

// --- controls wiring --------------------------------------------------------

function buildControls() {
  const groups = $('adjustGroups');
  groups.innerHTML = '';
  for (const g of GROUPS) {
    const details = document.createElement('details');
    details.className = 'acc';
    details.id = 'acc-group-' + g.id;
    const summary = document.createElement('summary');
    summary.textContent = g.label;
    const note = document.createElement('span');
    note.className = 'acc-note';
    summary.appendChild(note);
    const body = document.createElement('div');
    body.className = 'acc-body';
    for (const spec of ADJUSTMENTS.filter((a) => a.group === g.id)) {
      body.appendChild(sliderNode(spec));
    }
    details.append(summary, body);
    details.open = storageGet('acc-group.' + g.id) === '1';
    details.addEventListener('toggle', () => storageSet('acc-group.' + g.id, details.open ? '1' : '0'));
    groups.appendChild(details);
  }

  const toneAcc = $('acc-toning');
  toneAcc.open = storageGet('acc-toning') === '1';
  toneAcc.addEventListener('toggle', () => storageSet('acc-toning', toneAcc.open ? '1' : '0'));

  const presetBox = $('presets');
  presetBox.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.dataset.preset = p.id;
    b.onclick = () => applyPreset(p);
    presetBox.appendChild(b);
  }

  const tone = $('toneSelect');
  for (const t of TONES) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.label;
    tone.appendChild(o);
  }

  const picks = $('palettePick');
  picks.innerHTML = '';
  for (const p of PALETTE) {
    const label = document.createElement('label');
    label.className = 'chip color-chip';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.code = String(p.code);
    box.onchange = () => {
      state.paletteMode = 'custom';
      $('paletteMode').value = 'custom';
      if (box.checked) state.colors.add(p.code); else state.colors.delete(p.code);
      showCustomColors();
      clearPresetChips();
      captureItem();
      scheduleRender();
    };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = 'rgb(' + p.r + ',' + p.g + ',' + p.b + ')';
    label.append(box, sw, document.createTextNode(p.name));
    picks.appendChild(label);
  }

  tone.addEventListener('change', (e) => {
    state.tone = e.target.value;
    refreshAccordions();
    clearPresetChips();
    captureItem();
    scheduleRender();
  });
  $('invertCheck').addEventListener('change', (e) => {
    state.invert = e.target.checked;
    refreshAccordions();
    clearPresetChips();
    captureItem();
    scheduleRender();
  });
}

function sliderNode(spec) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  wrap.dataset.key = spec.key;

  const top = document.createElement('div');
  top.className = 'slider-top';
  const label = document.createElement('span');
  label.className = 'slider-label';
  label.textContent = spec.label;
  const value = document.createElement('output');
  value.className = 'slider-value';
  value.title = 'Клик — сбросить этот ползунок';
  top.append(label, value);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = '1';
  input.value = String(state.adj[spec.key]);
  input.setAttribute('aria-label', spec.label);

  value.textContent = formatAdjust(spec, state.adj[spec.key]);
  value.addEventListener('click', () => {
    input.value = String(defaultFor(spec));
    onSlider(spec, input);
  });
  input.addEventListener('input', () => onSlider(spec, input));
  input.addEventListener('dblclick', () => {
    input.value = String(defaultFor(spec));
    onSlider(spec, input);
  });

  wrap.append(top, input);
  if (spec.hints) {
    const hints = document.createElement('div');
    hints.className = 'slider-top';
    hints.style.fontSize = '11px';
    const l = document.createElement('span');
    l.textContent = spec.hints[0];
    const r = document.createElement('span');
    r.textContent = spec.hints[1];
    hints.append(l, r);
    wrap.appendChild(hints);
  }
  return wrap;
}

function defaultFor(spec) {
  return spec.def || 0;
}

function formatAdjust(spec, v) {
  if (spec.scale) return (v * spec.scale).toFixed(spec.digits || 2) + spec.unit;
  if (spec.unit === '%') return (v > 0 ? '+' : '') + v + '%';
  if (spec.unit === '°') return (v > 0 ? '+' : '') + v + '°';
  return String(v) + spec.unit;
}

function onSlider(spec, input) {
  const v = Number(input.value);
  state.adj[spec.key] = v;
  const wrap = input.closest('.slider');
  wrap.querySelector('.slider-value').textContent = formatAdjust(spec, v);
  wrap.classList.toggle('changed', v !== defaultFor(spec));
  refreshAccordions();
  clearPresetChips();
  captureItem();
  markStale();
}

function syncControls() {
  for (const spec of ADJUSTMENTS) {
    const wrap = document.querySelector('.slider[data-key="' + spec.key + '"]');
    if (!wrap) continue;
    const v = state.adj[spec.key];
    wrap.querySelector('input').value = String(v);
    wrap.querySelector('.slider-value').textContent = formatAdjust(spec, v);
    wrap.classList.toggle('changed', v !== defaultFor(spec));
  }
  const aspect = $('aspect');
  let best = aspect.value, bestD = Infinity;
  for (const opt of aspect.options) {
    const d = Math.abs(Number(opt.value) - state.aspect);
    if (d < bestD) { bestD = d; best = opt.value; }
  }
  aspect.value = best;
  $('ditherMode').value = state.dither;
  $('paletteMode').value = state.paletteMode;
  $('toneSelect').value = state.tone;
  $('invertCheck').checked = state.invert;
  showCustomColors();
  clearPresetChips();
  refreshAccordions();
}

// Collapsed groups still have to show that something is applied inside them.
function refreshAccordions() {
  for (const g of GROUPS) {
    const details = document.getElementById('acc-group-' + g.id);
    if (!details) continue;
    const changed = ADJUSTMENTS.filter((a) => a.group === g.id &&
      Number(state.adj[a.key]) !== defaultFor(a)).length;
    details.querySelector('.acc-note').textContent = changed ? changed + ' изм.' : '';
    details.classList.toggle('touched', changed > 0);
  }
  const toneAcc = $('acc-toning');
  if (!toneAcc) return;
  const label = state.tone !== 'none' && TONE_BY_ID[state.tone] ? TONE_BY_ID[state.tone].label : '';
  const note = [label, state.invert ? 'инверсия' : ''].filter(Boolean).join(' · ');
  toneAcc.querySelector('.acc-note').textContent = note;
  toneAcc.classList.toggle('touched', !!note);
}

function showCustomColors() {
  const box = $('palettePick');
  box.hidden = state.paletteMode !== 'custom';
  box.querySelectorAll('input').forEach((input) => {
    input.checked = state.colors.has(Number(input.dataset.code));
  });
}

function clearPresetChips() {
  $('presets').querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
}

function applyPreset(preset) {
  if (!state.image) { toast('Сначала выберите фото'); return; }
  for (const spec of ADJUSTMENTS) state.adj[spec.key] = defaultFor(spec);
  if (preset.adj) Object.assign(state.adj, preset.adj);
  state.tone = preset.tone || 'none';
  state.invert = !!preset.invert;
  if (preset.colors) {
    state.paletteMode = 'custom';
    state.colors = new Set(preset.colors);
  } else if (preset.palette) {
    state.paletteMode = preset.palette;
    state.colors = new Set(PALETTE.map((p) => p.code));
  } else {
    state.paletteMode = 'color';
    state.colors = new Set(PALETTE.map((p) => p.code));
  }
  if (preset.dither) state.dither = preset.dither;
  syncControls();
  const chip = $('presets').querySelector('[data-preset="' + preset.id + '"]');
  if (chip) chip.classList.add('active');
  captureItem();
  scheduleRender();
}

$('rotL').addEventListener('click', () => { state.rotation -= 90; captureItem(); rebuildBase(false); });
$('rotR').addEventListener('click', () => { state.rotation += 90; captureItem(); rebuildBase(false); });
$('flipH').addEventListener('click', () => { state.flipH = !state.flipH; captureItem(); rebuildBase(true); });
$('flipV').addEventListener('click', () => { state.flipV = !state.flipV; captureItem(); rebuildBase(true); });
$('resetSel').addEventListener('click', () => {
  resetSelection(); drawEditor(); captureItem(); scheduleRender();
});
$('clearBtn').addEventListener('click', () => {
  if (state.item) removeItem(state.item.id); else clearEditor();
});
$('aspect').addEventListener('change', (e) => {
  state.aspect = Number(e.target.value) || 0;
  clampSelection();
  drawEditor();
  captureItem();
  scheduleRender();
});
$('ditherMode').addEventListener('change', (e) => {
  state.dither = e.target.value;
  clearPresetChips();
  captureItem();
  scheduleRender();
});
$('paletteMode').addEventListener('change', (e) => {
  state.paletteMode = e.target.value;
  if (state.paletteMode === 'custom' && !state.colors.size) {
    state.colors = new Set(PALETTE.map((p) => p.code));
  }
  showCustomColors();
  clearPresetChips();
  captureItem();
  scheduleRender();
});
$('refreshPreview').addEventListener('click', () => renderFrame());
$('zoomReal').addEventListener('change', (e) => {
  const wrap = e.target.closest('.panel').querySelector('.preview-wrap');
  wrap.classList.toggle('real', e.target.checked);
});
preview.auto = localStorage.getItem('eink.autoRender') === '1';
$('autoRender').checked = preview.auto;
$('autoRender').addEventListener('change', (e) => {
  preview.auto = e.target.checked;
  try { localStorage.setItem('eink.autoRender', preview.auto ? '1' : '0'); } catch (err) { /* private mode */ }
  if (preview.auto && preview.stale) scheduleRender();
});
$('compareBtn').addEventListener('pointerdown', () => {
  if (!state.image) return;
  state.compare = true;
  renderFrame();
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
  $('compareBtn').addEventListener(evt, () => {
    if (!state.compare) return;
    state.compare = false;
    if (state.image) renderFrame();
  });
});
$('imgTitle').addEventListener('input', () => {
  if (state.item) state.item.title = $('imgTitle').value;
  updateNameHint();
  queueTitlesChanged();
});
$('imgTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('saveBtn').click(); }
});
$('resetAdjust').addEventListener('click', () => {
  applyPreset(PRESETS[0]);
  toast('Коррекция сброшена');
});

let queueTimer = null;
function queueTitlesChanged() {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(renderQueue, 350);
}

const usedSlugs = new Set();

// Where a save goes: the file the item was published as (an update), a free new
// name, or the existing file the user agreed to overwrite.
function planSave(item, title, copy) {
  const stem = slugify(title);
  if (!copy && item && item.slug) return { slug: item.slug, mode: 'update' };
  const taken = usedSlugs.has(stem);
  if (!taken || (!copy && $('replaceExisting').checked)) {
    return { slug: stem, mode: taken ? 'replace' : 'new' };
  }
  let n = 2;
  while (usedSlugs.has(stem + '-' + n) && n < 500) n++;
  return { slug: stem + '-' + n, mode: 'new' };
}

function updateNameHint() {
  const hint = $('nameHint');
  if (!state.image) {
    hint.textContent = '';
    $('replaceWrap').hidden = true;
    $('saveCopyBtn').hidden = true;
    return;
  }
  const title = $('imgTitle').value.trim() || 'фото';
  const stem = slugify(title);
  const plan = planSave(state.item, title, false);
  const lines = ['файл на карте: ' + plan.slug + '.e6'];
  if (plan.mode === 'update') lines.push('обновит уже сохранённое фото');
  else if (plan.mode === 'replace') lines.push('заменит фото с таким именем');
  else if (plan.slug !== stem) lines.push('имя занято, поэтому сохранится как ' + plan.slug);
  hint.textContent = lines.join(' · ');
  $('replaceWrap').hidden = plan.mode === 'update' || !usedSlugs.has(stem);
  $('saveCopyBtn').hidden = !(state.item && state.item.slug);
}

// --- upload -----------------------------------------------------------------

async function saveItem(item, copy) {
  if (state.item !== item) activateItem(item.id);
  captureItem();
  const title = ($('imgTitle').value || item.title || '').trim();
  const codes = renderFrame();
  if (!codes) throw new Error('нет изображения');
  const plan = planSave(item, title || item.title || 'фото', copy);
  const fd = new FormData();
  fd.append('file', new Blob([packCodes(codes)], { type: 'application/octet-stream' }),
    plan.slug + '.e6');
  const res = await fetch('/api/images/upload?title=' + encodeURIComponent(title || plan.slug),
    { method: 'POST', body: fd });
  let json = {};
  try { json = await res.json(); } catch (err) { /* no json */ }
  if (!res.ok || !json.ok) throw new Error(json.error || 'загрузка не прошла');
  item.slug = json.name;
  item.title = json.title || title;
  item.status = 'done';
  item.note = '';
  usedSlugs.add(json.name);
  $('imgTitle').value = item.title;
  renderQueue();
  return json;
}

async function saveCurrent(copy) {
  if (!state.item) { toast('Сначала выберите фото', 2500, true); return; }
  const btn = $('saveBtn');
  const copyBtn = $('saveCopyBtn');
  btn.disabled = true;
  copyBtn.disabled = true;
  try {
    const j = await saveItem(state.item, copy);
    toast(copy ? 'Сохранено как новое фото: «' + j.title + '»' : 'Сохранено: «' + j.title + '»');
    await refreshGallery();
    updateNameHint();
  } catch (err) {
    if (state.item) { state.item.status = 'error'; state.item.note = err.message; }
    toast('Ошибка: ' + err.message, 4500, true);
    renderQueue();
  } finally {
    btn.disabled = false;
    copyBtn.disabled = false;
  }
}

async function saveAll() {
  const pending = queue.filter((q) => q.status !== 'done');
  if (!pending.length) { toast('Все фото уже сохранены'); return; }
  $('saveBtn').disabled = true;
  $('saveAllBtn').disabled = true;
  const progress = $('progress');
  progress.hidden = false;
  let saved = 0, failed = 0;
  for (let i = 0; i < pending.length; i++) {
    progress.textContent = 'Загрузка ' + (i + 1) + ' из ' + pending.length + '…';
    try {
      await saveItem(pending[i]);
      saved++;
    } catch (err) {
      pending[i].status = 'error';
      pending[i].note = err.message;
      failed++;
      toast('«' + (pending[i].title || 'без имени') + '»: ' + err.message, 4000, true);
    }
  }
  progress.textContent = 'Сохранено ' + saved + (failed ? ' · ошибок ' + failed : '');
  updateSaveAllLabel();
  await refreshGallery();
  updateNameHint();
  $('saveBtn').disabled = false;
  $('saveAllBtn').disabled = false;
  setTimeout(() => { progress.hidden = true; }, 5000);
}

$('saveBtn').addEventListener('click', () => saveCurrent(false));
$('saveCopyBtn').addEventListener('click', () => saveCurrent(true));
$('saveAllBtn').addEventListener('click', saveAll);
$('replaceExisting').addEventListener('change', updateNameHint);

// --- file picking ----------------------------------------------------------

$('chooseBtn').addEventListener('click', (e) => { e.stopPropagation(); $('fileInput').click(); });
$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
$('fileInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((evt) => {
  $('drop').addEventListener(evt, (e) => { e.preventDefault(); $('drop').classList.add('hot'); });
});
$('drop').addEventListener('dragleave', (e) => { e.preventDefault(); $('drop').classList.remove('hot'); });
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('hot');
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
// Without this the browser opens the file and the whole page disappears.
// A drop outside the picker is still a drop: it lands in the editor tab.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const addTab = $('tab-add').classList.contains('active');
  if (!addTab && e.dataTransfer && e.dataTransfer.files.length) {
    showTab('add');
    addFiles(e.dataTransfer.files);
  }
});

// --- library ---------------------------------------------------------------

let library = [];
let selectedImage = null;
const rawCache = new Map();

function cacheRaw(name, bytes) {
  if (rawCache.size > 8) rawCache.delete(rawCache.keys().next().value);
  rawCache.set(name, bytes);
}

async function refreshGallery() {
  let items;
  try {
    const res = await fetch('/api/images');
    if (!res.ok) throw new Error('список недоступен');
    items = await res.json();
  } catch (err) {
    if (!library.length) gallery.innerHTML = '<li class="empty">Не удалось получить список фото.</li>';
    return;
  }
  library = Array.isArray(items) ? items : [];
  usedSlugs.clear();
  for (const item of library) usedSlugs.add(item.name);
  renderGallery();
  updateNameHint();
}

function renderGallery() {
  const query = $('libSearch').value.trim().toLowerCase();
  const sort = $('libSort').value;
  let items = library.slice();
  if (query) {
    items = items.filter((it) => (it.title || '').toLowerCase().includes(query) ||
                                 (it.name || '').toLowerCase().includes(query));
  }
  items.sort((a, b) => {
    if (sort === 'name') return (a.title || a.name).localeCompare(b.title || b.name, 'ru');
    if (sort === 'old') return (a.mtime || 0) - (b.mtime || 0);
    if (sort === 'size') return (b.size || 0) - (a.size || 0);
    return (b.mtime || 0) - (a.mtime || 0);
  });

  gallery.innerHTML = '';
  $('libCount').textContent = library.length ? library.length + ' шт.' : '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = library.length ? 'Ничего не найдено.' : 'Пока пусто — добавьте фото на вкладке «Добавить».';
    gallery.appendChild(li);
    return;
  }
  for (const item of items) gallery.appendChild(galleryRow(item));
}

function galleryRow(item) {
  const li = document.createElement('li');
  li.className = 'litem' + (selectedImage === item.name ? ' selected' : '') +
                 (item.current ? ' onscreen' : '');
  li.dataset.name = item.name;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'litem-main';
  main.title = 'Показать превью этого фото';
  const title = document.createElement('span');
  title.className = 'litem-title';
  title.textContent = item.title || item.name;
  const sub = document.createElement('span');
  sub.className = 'litem-sub';
  const bits = [item.name + '.e6', fmtBytes(item.size)];
  const when = fmtDate(item.mtime);
  if (when) bits.push(when);
  if (item.current) bits.push('на экране');
  sub.textContent = bits.join(' · ');
  main.append(title, sub);
  main.onclick = () => selectImage(item.name);

  const actions = document.createElement('div');
  actions.className = 'litem-actions';

  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = 'На экран';
  show.onclick = () => showOnFrame(item.name);

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.textContent = '✎';
  rename.title = 'Переименовать';
  rename.onclick = () => startInlineRename(li, item);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'Удалить';
  del.onclick = () => deleteImage(item.name, item.title || item.name);

  actions.append(show, rename, del);
  li.append(main, actions);
  return li;
}

function startInlineRename(li, item) {
  if (li.dataset.renaming) return;
  li.dataset.renaming = '1';
  const main = li.querySelector('.litem-main');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 60;
  input.value = item.title || item.name;
  main.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    delete li.dataset.renaming;
    if (commit && next && next !== (item.title || item.name)) {
      try {
        const j = await postForm('/api/images/rename', { name: item.name, title: next });
        item.title = j.title;
        toast('Переименовано: «' + j.title + '»');
      } catch (err) {
        toast('Ошибка: ' + err.message, 4000, true);
      }
      await refreshGallery();
    } else {
      renderGallery();
    }
    if (selectedImage === item.name) $('detailTitle').textContent = item.title || item.name;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function selectImage(name) {
  selectedImage = name;
  renderGallery();
  const item = library.find((it) => it.name === name);
  const detail = $('detail');
  detail.hidden = false;
  $('detailTitle').textContent = item ? (item.title || item.name) : name;
  $('detailMeta').textContent = 'загрузка превью (192 КБ)…';

  let bytes = rawCache.get(name);
  if (!bytes) {
    try {
      const res = await fetch('/api/file?name=' + encodeURIComponent(name));
      if (!res.ok) throw new Error('файл не найден');
      bytes = new Uint8Array(await res.arrayBuffer());
      cacheRaw(name, bytes);
    } catch (err) {
      if (selectedImage === name) $('detailMeta').textContent = 'не удалось загрузить: ' + err.message;
      return;
    }
  }
  if (selectedImage !== name) return;   // a newer click took over meanwhile
  if (bytes.length !== FRAME_BYTES) {
    $('detailMeta').textContent = 'файл повреждён: ' + bytes.length + ' байт вместо ' + FRAME_BYTES;
    return;
  }
  drawRawToCanvas(detailCanvas, bytes);
  $('detailMeta').textContent = item
    ? [item.name + '.e6', fmtBytes(item.size), fmtDate(item.mtime)].filter(Boolean).join(' · ')
    : name;
  detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('detailShow').addEventListener('click', () => selectedImage && showOnFrame(selectedImage));
$('detailRename').addEventListener('click', () => {
  if (!selectedImage) return;
  const li = gallery.querySelector('.litem[data-name="' + selectedImage + '"]');
  const item = library.find((it) => it.name === selectedImage);
  if (li && item) startInlineRename(li, item);
});
$('detailDelete').addEventListener('click', () => {
  if (!selectedImage) return;
  const item = library.find((it) => it.name === selectedImage);
  deleteImage(selectedImage, item ? (item.title || item.name) : selectedImage);
});
$('detailDownload').addEventListener('click', () => {
  if (!selectedImage) return;
  const a = document.createElement('a');
  a.href = '/api/file?name=' + encodeURIComponent(selectedImage);
  a.download = selectedImage + '.e6';
  document.body.appendChild(a);
  a.click();
  a.remove();
});
$('detailEdit').addEventListener('click', async () => {
  if (!selectedImage) return;
  const bytes = rawCache.get(selectedImage);
  if (!bytes) { toast('Сначала дождитесь превью этого фото', 2500, true); return; }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  drawRawToCanvas(canvas, bytes);
  let img = canvas;
  if (typeof createImageBitmap === 'function') {
    try { img = await createImageBitmap(canvas); } catch (err) { img = canvas; }
  }
  const item = library.find((it) => it.name === selectedImage);
  const entry = {
    id: ++uid,
    file: null,
    img,
    title: item ? (item.title || item.name) : selectedImage,
    // Deliberately not tied to the stored file: saving creates a new photo
    // unless the user ticks "replace".
    slug: '',
    status: 'new',
    note: '',
    edit: currentEdit(),
  };
  entry.edit.sel = null;
  entry.edit.aspect = DEFAULT_ASPECT;
  queue.push(entry);
  showTab('add');                 // the crop view needs a measured, visible panel
  $('drop').classList.add('compact');
  activateItem(entry.id);
  $('replaceExisting').checked = false;
  updateNameHint();
  toast('Кадр открыт в редакторе. Без галочки «Заменить» сохранится как новое фото.', 5000);
});

async function showOnFrame(name) {
  const item = library.find((it) => it.name === name);
  const label = item ? (item.title || item.name) : name;
  if (!confirm('Показать «' + label + '» на экране? Перерисовка занимает 20–35 секунд.')) return;
  toast('Рамка рисует…', 8000);
  renderingUntil = Date.now() + 45000;
  try {
    await postForm('/api/display', { name });
    for (const it of library) it.current = it.name === name;
    renderGallery();
  } catch (err) {
    toast('Ошибка: ' + err.message, 4000, true);
  }
}

async function deleteImage(name, label) {
  if (!confirm('Удалить «' + label + '» с рамки?')) return;
  try {
    await postForm('/api/images/delete', { name });
  } catch (err) {
    toast('Ошибка: ' + err.message, 4000, true);
    return;
  }
  rawCache.delete(name);
  if (selectedImage === name) {
    selectedImage = null;
    $('detail').hidden = true;
  }
  toast('Удалено');
  await refreshGallery();
}

$('refreshGallery').addEventListener('click', () => { rawCache.clear(); refreshGallery(); });
$('libSearch').addEventListener('input', renderGallery);
$('libSort').addEventListener('change', renderGallery);

// --- status / network / power ----------------------------------------------

let renderingUntil = 0;

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.connected) {
      statusEl.textContent = 'Подключено: ' + s.ssid + ' · http://' + s.ip;
    } else if (s.apMode) {
      statusEl.textContent = 'Режим настройки: ' + s.apSsid + ' · http://' + s.apIp;
    } else {
      statusEl.textContent = 'Нет сети';
    }
    const lines = [];
    lines.push('Режим: ' + (s.apMode ? 'точка доступа для настройки'
                                      : (s.connected ? 'клиент Wi-Fi' : 'офлайн')));
    if (s.connected) {
      lines.push('Сеть: ' + s.ssid);
      lines.push('Адрес: http://' + s.ip);
    }
    if (s.apMode) {
      lines.push('Точка доступа: ' + s.apSsid);
      lines.push('Адрес: http://' + s.apIp);
    }
    lines.push('SD-карта: ' + (s.sd ? 'подключена' : 'не найдена'));
    if (s.sd && s.sdTotalMb) {
      lines.push('На карте занято: ' + s.sdUsedMb + ' МБ из ' + s.sdTotalMb + ' МБ');
    }
    lines.push('Часы DS3231: ' + (s.rtc ? 'найдены' : 'не найдены'));
    lines.push('Прошивка: ' + s.firmware + ' ' + s.version);
    if (s.image) lines.push('Сейчас на экране: ' + titleFor(s.image));
    $('netInfo').textContent = lines.join('\n');
    $('sdInfo').textContent = s.sd
      ? 'Одно фото — ровно 192 000 байт' + (s.sdTotalMb ? '; занято ' + s.sdUsedMb + ' из ' + s.sdTotalMb + ' МБ' : '')
      : 'SD-карта не смонтирована: библиотека и загрузка недоступны.';
    if (!document.activeElement || document.activeElement.id !== 'ssid') {
      if (s.connected && s.ssid) $('ssid').value = s.ssid;
    }
  } catch (err) {
    statusEl.textContent = Date.now() < renderingUntil
      ? 'Рамка сейчас рисует изображение…'
      : 'Нет связи с рамкой';
  }
}

function titleFor(slug) {
  const item = library.find((it) => it.name === slug);
  return item ? (item.title || item.name) + ' (' + slug + ')' : slug;
}

$('saveWifi').addEventListener('click', async () => {
  const ssid = $('ssid').value.trim();
  const password = $('password').value;
  if (!ssid) { toast('Введите имя сети', 2500, true); return; }
  toast('Сохраняю и подключаюсь…', 6000);
  try {
    await postForm('/api/wifi', { ssid, password });
    toast('Логин сохранён, подключаюсь…', 5000);
  } catch (err) {
    toast('Сохранено; сеть переключается', 5000);
  }
});

$('resetWifi').addEventListener('click', async () => {
  if (!confirm('Забыть текущую сеть и включить режим настройки?')) return;
  try { await fetch('/api/wifi/reset', { method: 'POST' }); } catch (err) { /* expected */ }
  toast('Переключаюсь в режим настройки…', 5000);
});

$('showStatus').addEventListener('click', async () => {
  toast('Рамка рисует экран статуса…', 6000);
  renderingUntil = Date.now() + 45000;
  try { await fetch('/api/status-screen', { method: 'POST' }); } catch (err) { /* expected */ }
});

$('autonomyTest').addEventListener('click', async () => {
  if (!confirm('Запустить тест автономности? Рамка будет засыпать и просыпаться каждую минуту. Остановка — кнопкой reset.')) return;
  const btn = $('autonomyTest');
  btn.disabled = true;
  try {
    const res = await fetch('/api/autonomy-test', { method: 'POST' });
    let j = {};
    try { j = await res.json(); } catch (err) { /* the frame may already sleep */ }
    if (!res.ok || j.ok === false) throw new Error(j.error || 'запрос не прошёл');
    toast('Тест запущен, рамка засыпает…', 8000);
  } catch (err) {
    btn.disabled = false;
    toast('Ошибка: ' + err.message, 5000, true);
  }
});

// --- tabs & boot -----------------------------------------------------------

function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const tab = $('tab-' + name);
  if (tab) tab.classList.add('active');
  // Hidden canvases have no useful size: the crop view is measured again here.
  if (name === 'add' && state.image) { layoutEditor(); drawEditor(); }
  if (name === 'library') refreshGallery();
}

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
$('goAddBtn').addEventListener('click', () => showTab('add'));

buildControls();
syncControls();
refreshStatus();
refreshGallery();
setInterval(refreshStatus, 5000);

'use strict';
// Client-side image pipeline. Everything here prepares a 4bpp Spectra 6 frame
// (two pixels per byte, high nibble = left pixel) that the firmware writes to SD.

const W = 800, H = 480, ASPECT = W / H;
// Colour codes are the GxEPD2 "logical" 7-colour codes: the firmware feeds them
// to GxEPD2, which maps them to the panel's native Spectra 6 values.
const PALETTE = [
  { code: 0x0, r: 0,   g: 0,   b: 0   }, // black
  { code: 0x1, r: 255, g: 255, b: 255 }, // white
  { code: 0x2, r: 0,   g: 255, b: 0   }, // green
  { code: 0x3, r: 0,   g: 0,   b: 255 }, // blue
  { code: 0x4, r: 255, g: 0,   b: 0   }, // red
  { code: 0x5, r: 255, g: 255, b: 0   }, // yellow
];
const BY_CODE = {};
for (const p of PALETTE) BY_CODE[p.code] = p;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const toastEl = $('toast');
const gallery = $('gallery');
const editCanvas = $('editCanvas');
const editCtx = editCanvas.getContext('2d');
const previewCanvas = $('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');

const base = document.createElement('canvas');
const baseCtx = base.getContext('2d');
const out = document.createElement('canvas');
out.width = W; out.height = H;
const outCtx = out.getContext('2d', { willReadFrequently: true });

const state = {
  image: null,
  rotation: 0,
  sel: { x: 0, y: 0, w: 1, h: 1 },
  lockAspect: true,
  dither: false,
  scale: 1,
  drag: null,
  codes: null,
  previewDirty: false,
};

function toast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// --- colour quantisation -----------------------------------------------------

function nearestColor(r, g, b) {
  let best = PALETTE[0], bestD = Infinity;
  for (const p of PALETTE) {
    const dr = r - p.r, dg = g - p.g, db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function quantize(rgba, width, height, dither) {
  const codes = new Uint8Array(width * height);
  if (!dither) {
    for (let i = 0; i < width * height; i++) {
      const k = i * 4;
      codes[i] = nearestColor(rgba[k], rgba[k + 1], rgba[k + 2]).code;
    }
    return codes;
  }

  const buf = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) buf[i] = rgba[i];
  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  const add = (x, y, er, eg, eb, f) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const k = (y * width + x) * 4;
    buf[k] += er * f; buf[k + 1] += eg * f; buf[k + 2] += eb * f;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const r = clamp(buf[k]), g = clamp(buf[k + 1]), b = clamp(buf[k + 2]);
      const p = nearestColor(r, g, b);
      codes[y * width + x] = p.code;
      const er = r - p.r, eg = g - p.g, eb = b - p.b;
      add(x + 1, y,     er, eg, eb, 7 / 16);
      add(x - 1, y + 1, er, eg, eb, 3 / 16);
      add(x,     y + 1, er, eg, eb, 5 / 16);
      add(x + 1, y + 1, er, eg, eb, 1 / 16);
    }
  }
  return codes;
}

function packCodes(codes, width, height) {
  const bytes = new Uint8Array((width * height) / 2);
  const row = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 2) {
      bytes[y * row + x / 2] = (codes[y * width + x] << 4) | codes[y * width + x + 1];
    }
  }
  return bytes;
}

function codesToImageData(codes, width, height) {
  const img = new ImageData(width, height);
  const d = img.data;
  for (let i = 0; i < width * height; i++) {
    const p = BY_CODE[codes[i]] || BY_CODE[0x1];
    const k = i * 4;
    d[k] = p.r; d[k + 1] = p.g; d[k + 2] = p.b; d[k + 3] = 255;
  }
  return img;
}

function drawRawToCanvas(target, bytes) {
  const tw = target.width, th = target.height;
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const byte = bytes[i >> 1];
    const code = (i & 1) ? (byte & 0x0F) : (byte >> 4);
    const p = BY_CODE[code] || BY_CODE[0x1];
    const k = i * 4;
    img.data[k] = p.r; img.data[k + 1] = p.g; img.data[k + 2] = p.b; img.data[k + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(tmp, 0, 0, tw, th);
}

// --- editor ------------------------------------------------------------------

function setImage(img) {
  state.image = img;
  state.rotation = 0;
  rebuildBase();
}

function rebuildBase() {
  if (!state.image) return;
  let angle = (state.rotation % 360 + 360) % 360;
  const iw = state.image.naturalWidth, ih = state.image.naturalHeight;
  const swap = (angle === 90 || angle === 270);
  base.width = swap ? ih : iw;
  base.height = swap ? iw : ih;
  baseCtx.save();
  baseCtx.translate(base.width / 2, base.height / 2);
  baseCtx.rotate(angle * Math.PI / 180);
  baseCtx.drawImage(state.image, -iw / 2, -ih / 2);
  baseCtx.restore();
  resetSelection();
  layoutEditor();
  drawEditor();
  schedulePreview();
  $('editor').hidden = false;
}

function resetSelection() {
  const bw = base.width, bh = base.height;
  if (state.lockAspect) {
    let w = bw, h = bw / ASPECT;
    if (h > bh) { h = bh; w = bh * ASPECT; }
    state.sel = { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
  } else {
    state.sel = { x: 0, y: 0, w: bw, h: bh };
  }
}

function layoutEditor() {
  const maxW = 720, maxH = 460;
  const s = Math.min(maxW / base.width, maxH / base.height, 1);
  state.scale = s;
  editCanvas.width = Math.round(base.width * s);
  editCanvas.height = Math.round(base.height * s);
}

function selectionInView() {
  const s = state.scale;
  return {
    x: state.sel.x * s, y: state.sel.y * s,
    w: state.sel.w * s, h: state.sel.h * s,
  };
}

function handlePoints(r) {
  const mx = r.x + r.w / 2, my = r.y + r.h / 2;
  const pts = {
    nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h],
  };
  if (!state.lockAspect) {
    pts.n = [mx, r.y]; pts.s = [mx, r.y + r.h]; pts.w = [r.x, my]; pts.e = [r.x + r.w, my];
  }
  return pts;
}

function drawEditor() {
  const cw = editCanvas.width, ch = editCanvas.height;
  editCtx.clearRect(0, 0, cw, ch);
  editCtx.drawImage(base, 0, 0, cw, ch);

  const r = selectionInView();
  editCtx.fillStyle = 'rgba(0,0,0,0.5)';
  editCtx.fillRect(0, 0, cw, r.y);
  editCtx.fillRect(0, r.y + r.h, cw, ch - (r.y + r.h));
  editCtx.fillRect(0, r.y, r.x, r.h);
  editCtx.fillRect(r.x + r.w, r.y, cw - (r.x + r.w), r.h);

  editCtx.strokeStyle = '#4f8cff';
  editCtx.lineWidth = 2;
  editCtx.strokeRect(r.x, r.y, r.w, r.h);

  editCtx.fillStyle = '#fff';
  editCtx.strokeStyle = '#4f8cff';
  for (const key in handlePoints(r)) {
    const [hx, hy] = handlePoints(r)[key];
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
  if (state.lockAspect) {
    if (w / h > ASPECT) w = h * ASPECT; else h = w / ASPECT;
    if (w > bw) { w = bw; h = w / ASPECT; }
    if (h > bh) { h = bh; w = h * ASPECT; }
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
  if (state.lockAspect) {
    let ax, ay;
    if (mode === 'nw') { ax = right; ay = bottom; }
    else if (mode === 'ne') { ax = o.x; ay = bottom; }
    else if (mode === 'se') { ax = o.x; ay = o.y; }
    else { ax = right; ay = o.y; }
    let w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (w / h > ASPECT) h = w / ASPECT; else w = h * ASPECT;
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
  editCanvas.setPointerCapture(ev.pointerId);
  state.drag = {
    mode: handle,
    start: p,
    orig: { ...state.sel },
  };
});

editCanvas.addEventListener('pointermove', (ev) => {
  if (!state.drag) {
    const p = pointerPos(ev);
    const h = pickHandle(p);
    editCanvas.style.cursor = h === 'move' ? 'move' : h ? 'nwse-resize' : 'crosshair';
    return;
  }
  const p = pointerPos(ev);
  const s = state.scale;
  if (state.drag.mode === 'move') {
    const dx = (p.x - state.drag.start.x) / s;
    const dy = (p.y - state.drag.start.y) / s;
    state.sel = {
      x: state.drag.orig.x + dx, y: state.drag.orig.y + dy,
      w: state.drag.orig.w, h: state.drag.orig.h,
    };
    clampSelection();
  } else {
    resizeSelection(state.drag.mode, p.x / s, p.y / s);
  }
  drawEditor();
  schedulePreview();
});

function endDrag(ev) {
  if (state.drag) {
    state.drag = null;
    schedulePreview();
  }
}
editCanvas.addEventListener('pointerup', endDrag);
editCanvas.addEventListener('pointercancel', endDrag);

// --- preview -----------------------------------------------------------------

function schedulePreview() {
  if (state.previewDirty) return;
  state.previewDirty = true;
  requestAnimationFrame(() => {
    state.previewDirty = false;
    updatePreview();
  });
}

function updatePreview() {
  if (!state.image) return;
  const s = state.sel;
  outCtx.clearRect(0, 0, W, H);
  outCtx.drawImage(base, s.x, s.y, s.w, s.h, 0, 0, W, H);
  const data = outCtx.getImageData(0, 0, W, H).data;
  state.codes = quantize(data, W, H, state.dither);
  const img = codesToImageData(state.codes, W, H);
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(img, 0, 0);
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(tmp, 0, 0, previewCanvas.width, previewCanvas.height);
}

// --- upload / gallery --------------------------------------------------------

$('fileInput').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  $('imgName').value = name;
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    setImage(img);
    toast('Image loaded');
  };
  img.src = URL.createObjectURL(file);
});

$('rotL').addEventListener('click', () => { state.rotation -= 90; rebuildBase(); });
$('rotR').addEventListener('click', () => { state.rotation += 90; rebuildBase(); });
$('resetSel').addEventListener('click', () => { resetSelection(); drawEditor(); schedulePreview(); });
$('lockAspect').addEventListener('change', (e) => {
  state.lockAspect = e.target.checked;
  clampSelection(); drawEditor(); schedulePreview();
});
$('dither').addEventListener('change', (e) => {
  state.dither = e.target.checked;
  schedulePreview();
});

$('saveBtn').addEventListener('click', async () => {
  if (!state.codes) { toast('Load an image first'); return; }
  const name = ($('imgName').value || 'image').trim();
  const bytes = packCodes(state.codes, W, H);
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name + '.e6');
  $('saveBtn').disabled = true;
  try {
    const res = await fetch('/api/images/upload', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || 'upload failed');
    toast('Saved "' + j.name + '"');
    refreshGallery();
  } catch (err) {
    toast('Error: ' + err.message, 4000);
  } finally {
    $('saveBtn').disabled = false;
  }
});

async function refreshGallery() {
  gallery.innerHTML = '<p class="hint">loading…</p>';
  try {
    const items = await (await fetch('/api/images')).json();
    gallery.innerHTML = '';
    if (!items.length) {
      gallery.innerHTML = '<p class="hint">No images yet.</p>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card';
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 120;
      card.appendChild(canvas);
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      card.appendChild(name);
      const size = document.createElement('div');
      size.className = 'size';
      size.textContent = (item.size / 1024).toFixed(0) + ' KB';
      card.appendChild(size);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const show = document.createElement('button');
      show.textContent = 'Show';
      show.onclick = () => showOnFrame(item.name);
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'danger';
      del.onclick = () => deleteImage(item.name);
      actions.append(show, del);
      card.appendChild(actions);
      gallery.appendChild(card);

      fetch('/api/file?name=' + encodeURIComponent(item.name))
        .then((r) => r.arrayBuffer())
        .then((buf) => drawRawToCanvas(canvas, new Uint8Array(buf)))
        .catch(() => {});
    }
  } catch (err) {
    gallery.innerHTML = '<p class="hint">Failed to load gallery.</p>';
  }
}

async function showOnFrame(name) {
  if (!confirm('Render "' + name + '" on the frame? This takes 20-35 seconds.')) return;
  toast('Rendering on frame…', 6000);
  try {
    const body = 'name=' + encodeURIComponent(name);
    const res = await fetch('/api/display', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await res.json();
    toast(j.ok ? 'Sent to frame' : ('Error: ' + j.error), 4000);
  } catch (err) {
    toast('Error: ' + err.message, 4000);
  }
}

async function deleteImage(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    const res = await fetch('/api/images/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=' + encodeURIComponent(name),
    });
    const j = await res.json();
    toast(j.ok ? 'Deleted' : ('Error: ' + j.error));
    refreshGallery();
  } catch (err) {
    toast('Error: ' + err.message, 4000);
  }
}

$('refreshGallery').addEventListener('click', refreshGallery);

// --- network -----------------------------------------------------------------

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.connected) {
      statusEl.textContent = 'Connected: ' + s.ssid + ' • http://' + s.ip;
    } else if (s.apMode) {
      statusEl.textContent = 'Setup AP: ' + s.apSsid + ' • http://' + s.apIp;
    } else {
      statusEl.textContent = 'Offline';
    }
    const lines = [];
    lines.push('Mode: ' + (s.apMode ? 'Setup access point' : (s.connected ? 'Station' : 'Offline')));
    if (s.connected) {
      lines.push('Network: ' + s.ssid);
      lines.push('Address: http://' + s.ip);
    }
    if (s.apMode) {
      lines.push('Access point: ' + s.apSsid);
      lines.push('Address: http://' + s.apIp);
    }
    lines.push('SD card: ' + (s.sd ? 'mounted' : 'not mounted'));
    lines.push('Firmware: ' + s.firmware + ' ' + s.version);
    if (s.image) lines.push('Current image: ' + s.image);
    $('netInfo').textContent = lines.join('\n');
    if (!document.activeElement || document.activeElement.id !== 'ssid') {
      if (s.connected && s.ssid) $('ssid').value = s.ssid;
    }
  } catch (err) {
    statusEl.textContent = 'Connection lost';
  }
}

$('saveWifi').addEventListener('click', async () => {
  const ssid = $('ssid').value.trim();
  const password = $('password').value;
  if (!ssid) { toast('Enter an SSID'); return; }
  toast('Saving and connecting…', 6000);
  try {
    const res = await fetch('/api/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'ssid=' + encodeURIComponent(ssid) + '&password=' + encodeURIComponent(password),
    });
    const j = await res.json();
    toast(j.ok ? 'Credentials saved; connecting…' : ('Error: ' + j.error), 5000);
  } catch (err) {
    toast('Saved (connection is switching modes)', 5000);
  }
});

$('resetWifi').addEventListener('click', async () => {
  if (!confirm('Forget the current network and restart the setup access point?')) return;
  try {
    await fetch('/api/wifi/reset', { method: 'POST' });
    toast('Switching to setup mode…', 5000);
  } catch (err) {
    toast('Switching to setup mode…', 5000);
  }
});

$('showStatus').addEventListener('click', async () => {
  toast('Rendering status screen…', 6000);
  try {
    await fetch('/api/status-screen', { method: 'POST' });
  } catch (err) {}
});

// --- tabs & boot -------------------------------------------------------------

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

refreshStatus();
refreshGallery();
setInterval(refreshStatus, 4000);

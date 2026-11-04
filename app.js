import { SCHEMA, dimensions, normalizeResult, inspectRegion, enabledLayers, boardFor, cleanRaster, pathCommands } from './lib/reconstruction.js';

const $ = id => document.getElementById(id);
const state = { assets: [], selected: null, layer: null, view: 'rebuilt', drawing: false, busy: false, editorDirty: false, editorKey: '', pending: [], config: { useCustom: false }, server: null };
let previewVersion = 0, toastTimer, dirty = false;
const current = () => state.assets.find(a => a.id === state.selected);
const selectedLayer = () => current()?.layers.find(l => l.id === state.layer);
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
function changed(asset) { if (asset) asset.reviewed = false; dirty = true; $('save-status').textContent = '有未保存修改'; }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function discardDraft() { if (state.editorDirty && !confirm('图层修改尚未应用，是否放弃这些输入？')) return false; state.editorDirty = false; return true; }
function choose(id) { if (!discardDraft()) return; state.selected = id; state.layer = null; state.drawing = false; render(); }
const imageCache = new Map();
async function imageFor(asset) {
  if (imageCache.get(asset.id)?.src === asset.dataUrl) return imageCache.get(asset.id);
  const img = new Image(); img.src = asset.dataUrl; await img.decode();
  if (img.naturalWidth !== asset.width || img.naturalHeight !== asset.height) throw new Error('原图尺寸与项目记录不一致。');
  imageCache.set(asset.id, img); if (imageCache.size > 2) imageCache.delete(imageCache.keys().next().value);
  return img;
}
function canvas(width, height) { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; }
async function sourceCanvas(asset) { const c = canvas(asset.width, asset.height); c.getContext('2d').drawImage(await imageFor(asset), 0, 0); return c; }
async function recheck(asset) {
  const c = await sourceCanvas(asset), pixels = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  for (const layer of asset.layers) { layer.check = inspectRegion(pixels, c.width, c.height, layer); if (!layer.check.safe) layer.enabled = false; }
  c.width = c.height = 1;
}
function textLines(ctx, layer) {
  const lines = [];
  for (const paragraph of layer.characters.split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const piece of paragraph.match(/\S+\s*|\s+/g) || [paragraph]) {
      if (ctx.measureText(line + piece).width <= layer.width) { line += piece; continue; }
      if (line) { lines.push(line.trimEnd()); line = ''; }
      if (ctx.measureText(piece).width <= layer.width) { line = piece; continue; }
      for (const ch of piece) { if (line && ctx.measureText(line + ch).width > layer.width) { lines.push(line); line = ''; } line += ch; }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
function drawLayer(ctx, layer) {
  ctx.fillStyle = layer.color;
  if (layer.type === 'VECTOR') {
    ctx.save(); ctx.translate(layer.x, layer.y); ctx.strokeStyle = layer.color; ctx.lineWidth = layer.strokeWidth || 1;
    for (const p of layer.vectorPaths) { const path = new Path2D(p.data); if (layer.filled && p.windingRule !== 'NONE') ctx.fill(path, p.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'); if (layer.strokeWidth) ctx.stroke(path); }
    ctx.restore(); return false;
  }
  if (layer.type === 'RECTANGLE') { ctx.fillRect(layer.x, layer.y, layer.width, layer.height); return false; }
  if (layer.type === 'ELLIPSE') { ctx.beginPath(); ctx.ellipse(layer.x + layer.width / 2, layer.y + layer.height / 2, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2); ctx.fill(); return false; }
  ctx.font = layer.fontWeight + ' ' + layer.fontSize + 'px ' + JSON.stringify(layer.fontFamily) + ', Arial, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = layer.align;
  const lines = textLines(ctx, layer), lineHeight = layer.fontSize * layer.lineHeight;
  const x = layer.x + (layer.align === 'center' ? layer.width / 2 : layer.align === 'right' ? layer.width : 0);
  lines.forEach((line, i) => ctx.fillText(line, x, layer.y + i * lineHeight));
  return lines.length * lineHeight > layer.height + 1 || lines.some(line => ctx.measureText(line).width > layer.width + 1);
}
async function builtCanvas(asset, includeText = true) {
  const c = await sourceCanvas(asset), ctx = c.getContext('2d');
  const layers = enabledLayers(asset.layers);
  if (layers.length) { const image = ctx.getImageData(0, 0, c.width, c.height); image.data.set(cleanRaster(image.data, c.width, c.height, layers)); ctx.putImageData(image, 0, 0); }
  const overflow = [];
  if (includeText) for (const layer of layers) if (drawLayer(ctx, layer)) overflow.push(layer.name);
  return { canvas: c, overflow };
}
async function drawPreview() {
  const version = ++previewVersion, a = current();
  $('empty-state').hidden = !!a; $('canvas-wrap').hidden = !a;
  if (!a) return;
  try {
    const result = state.view === 'original' ? { canvas: await sourceCanvas(a), overflow: [] } : await builtCanvas(a);
    if (version !== previewVersion) { result.canvas.width = 1; return; }
    const target = $('preview-canvas'); target.width = a.width; target.height = a.height; target.getContext('2d').drawImage(result.canvas, 0, 0); result.canvas.width = result.canvas.height = 1;
    a.overflow = result.overflow;
    $('preview-summary').textContent = result.overflow.length ? '文字可能超出区域：' + result.overflow.join('、') : state.view === 'original' ? '正在查看原图 · 未叠加任何图层' : a.layers.filter(l => l.enabled).length + ' 个原生图层 · 其余内容保留原图';
    if (result.overflow.length) a.reviewed = false;
    renderSelection(); updateExport();
  } catch (error) { toast(error.message); }
}
function renderSelection(box = selectedLayer()) {
  const el = $('selection-box'); el.hidden = !box;
  if (box && current()) { el.style.left = box.x / current().width * 100 + '%'; el.style.top = box.y / current().height * 100 + '%'; el.style.width = box.width / current().width * 100 + '%'; el.style.height = box.height / current().height * 100 + '%'; }
}
function updateExport() {
  const native = state.assets.reduce((n, a) => n + a.layers.filter(l => l.enabled).length, 0);
  const eligible = native && state.assets.length && state.assets.every(a => a.reviewed && !a.overflow?.length) && !state.busy && !state.editorDirty;
  $('export-open').disabled = !eligible;
  $('export-reason').textContent = state.busy ? '正在处理图片…' : state.editorDirty ? '请先应用图层修改' : !state.assets.length ? '先上传图片并分析' : !native ? '尚无可编辑文字或图形，请分析或调整候选' : state.assets.some(a => a.overflow?.length) ? '请调整超出边界的文字' : state.assets.some(a => !a.reviewed) ? '请在预览下方逐图勾选核对' : native + ' 个原生图层 · 可以导出';
  $('asset-reviewed').disabled = state.busy || state.editorDirty || !!current()?.overflow?.length;
  $('asset-reviewed').checked = !!current()?.reviewed;
}
function renderEditor() {
  const l = selectedLayer(); $('layer-editor').hidden = !l; if (!l) return;
  const key = current().id + '/' + l.id;
  if (state.editorDirty && state.editorKey === key) return;
  state.editorDirty = false; state.editorKey = key;
  $('layer-check').textContent = l.check?.reason || '等待检查'; $('layer-check').className = 'check-note' + (l.check?.safe ? ' safe' : '');
  $('layer-enabled').checked = l.enabled; $('layer-enabled').disabled = state.busy || !l.check?.safe;
  $('layer-text').value = l.characters || ''; $('copy-label').hidden = l.type !== 'TEXT'; $('size-label').hidden = l.type !== 'TEXT'; $('family-label').hidden = l.type !== 'TEXT';
  $('layer-color').value = l.color; $('layer-font-size').value = l.fontSize || 24; $('layer-font').value = l.fontFamily || 'Arial';
  for (const key of ['x', 'y', 'width', 'height']) $('layer-' + key).value = l[key];
}
function render() {
  const a = current(); $('asset-count').textContent = state.assets.length + ' / 20';
  $('asset-list').replaceChildren();
  for (const asset of state.assets) {
    const button = element('button', 'asset-card' + (a === asset ? ' selected' : '')); button.type = 'button';
    const img = new Image(); img.src = asset.dataUrl; img.alt = ''; const info = element('span', 'asset-info');
    info.append(element('strong', '', asset.name), element('small', '', asset.width + ' × ' + asset.height + 'px'), element('small', 'asset-state', asset.reviewed ? '✓ 已核对' : asset.analyzed ? asset.layers.filter(l => l.enabled).length + ' 层已启用 / ' + asset.layers.length + ' 个候选' : '原图 · 待拆解'));
    button.append(img, info); button.onclick = () => choose(asset.id); $('asset-list').append(button);
  }
  $('preview-title').textContent = a?.name || '画面预览'; $('preview-meta').textContent = a ? a.width + ' × ' + a.height + 'px · 原始尺寸' : '按原图尺寸重建';
  $('image-actions').hidden = !a; $('manual-add').disabled = !a || state.busy; $('manual-add').textContent = state.drawing ? '正在画区 · 按 Esc 取消' : '＋ 手动画出文字区域';
  $('analyze-one').disabled = !a || state.busy; $('analyze-one').textContent = state.busy ? '正在分析…' : a?.analyzed ? '重新分析此图' : '分析此图';
  $('analyze-all').disabled = !state.assets.length || state.busy; $('remove-image').disabled = state.busy;
  $('canvas-wrap').classList.toggle('drawing', state.drawing);
  for (const view of ['original', 'rebuilt']) { $('view-' + view).classList.toggle('active', state.view === view); $('view-' + view).setAttribute('aria-pressed', String(state.view === view)); }
  $('layer-count').textContent = (a?.layers.filter(l => l.enabled).length || 0) + ' 层已启用';
  $('analysis-status').textContent = a?.error || a?.notes || ''; $('analysis-status').classList.toggle('failed', !!a?.error);
  $('layer-list').replaceChildren();
  if (!a?.layers.length) $('layer-list').append(element('div', 'empty-layers', a ? '照片与复杂细节保留为图片。可点击分析，或手动画出文字区域。' : '等待选择图片'));
  for (const l of a?.layers || []) {
    const b = element('button', 'layer-card' + (state.layer === l.id ? ' active' : '')); b.type = 'button';
    const info = element('span'); info.append(element('strong', '', l.name), element('small', l.enabled ? 'editable' : '', l.enabled ? '✓ ' + (l.type === 'TEXT' ? '文字层' : '矢量图形') + (l.check?.method === 'inpaint' ? ' · 背景近似修补' : ' · 已启用') : l.check?.safe ? '可提取 · 等待核对启用' : '需调整 · ' + l.check?.reason));
    b.append(element('span', 'layer-icon', l.type === 'TEXT' ? 'T' : l.type === 'ELLIPSE' ? '○' : '□'), info);
    b.onclick = () => { if (!discardDraft()) return; state.layer = l.id; state.drawing = false; render(); }; $('layer-list').append(b);
  }
  renderEditor(); updateExport(); void drawPreview();
}
function fileData(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('无法读取文件。')); r.readAsDataURL(file); }); }
async function decodeFile(file) {
  if (!file.size || file.size > 30 * 1024 * 1024) throw new Error('图片为空或超过 30MB。');
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer()); let mime;
  if ([137,80,78,71,13,10,26,10].every((n,i) => b[i] === n)) mime = 'image/png';
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
  else if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') mime = 'image/webp';
  else throw new Error('仅支持真实 PNG、JPEG 或 WebP 文件。');
  const dataUrl = await fileData(new Blob([file], { type: mime })), img = new Image(); img.src = dataUrl;
  try { await img.decode(); } catch { throw new Error('图片损坏或浏览器无法解码。'); }
  dimensions(img.naturalWidth, img.naturalHeight);
  return { id: crypto.randomUUID(), name: file.name || 'image', width: img.naturalWidth, height: img.naturalHeight, dataUrl, layers: [], analyzed: false, reviewed: false, notes: '', error: '' };
}
async function addFiles(files) {
  if (state.busy) return toast('请等待当前操作完成。');
  if (!discardDraft()) return;
  for (const file of files) {
    if (state.assets.length >= 20) { toast('最多 20 张图片。其余文件未添加。'); break; }
    try { const asset = await decodeFile(file); state.assets.push(asset); state.selected = asset.id; state.layer = null; changed(); }
    catch (error) { toast(file.name + '：' + error.message); }
  }
  render();
}
$('image-input').onchange = async e => { await addFiles(e.target.files); e.target.value = ''; };
$('dropzone').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('image-input').click(); } };
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, e => { e.preventDefault(); $('dropzone').classList.add('over'); });
$('dropzone').ondragleave = () => $('dropzone').classList.remove('over');
$('dropzone').ondrop = async e => { e.preventDefault(); $('dropzone').classList.remove('over'); await addFiles(e.dataTransfer.files); };
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
for (const view of ['original', 'rebuilt']) $('view-' + view).onclick = () => { state.view = view; render(); };
$('asset-reviewed').onchange = e => { if (state.busy || current()?.overflow?.length) return; current().reviewed = e.target.checked; changed(); render(); };
$('remove-image').onclick = () => { const a = current(); if (!a || state.busy || !confirm('移除此图及其候选图层？原始文件不会被删除。')) return; state.assets = state.assets.filter(x => x !== a); imageCache.delete(a.id); changed(); choose(state.assets[0]?.id || null); };
$('delete-layer').onclick = () => { const a = current(); if (!a || state.busy) return; a.layers = a.layers.filter(l => l.id !== state.layer); state.layer = null; state.editorDirty = false; changed(a); render(); };
for (const field of $('layer-editor').querySelectorAll('input:not([type=checkbox]), textarea')) field.addEventListener('input', () => {
  if (!current()) return; state.editorDirty = true; changed(current()); $('layer-enabled').disabled = true;
  $('layer-check').textContent = '有尚未应用的修改。请点击「应用修改并重新检查」，再启用和核对。'; $('layer-check').className = 'check-note'; updateExport();
});
$('layer-enabled').onchange = e => {
  const a = current(), l = selectedLayer(); if (!l || state.busy) return;
  l.enabled = e.target.checked;
  try { enabledLayers(a.layers); } catch (error) { l.enabled = false; toast(error.message); }
  changed(a); render();
};
$('layer-editor').onsubmit = async e => {
  e.preventDefault(); const a = current(), l = selectedLayer(); if (!l || state.busy) return;
  const next = { ...l, color: $('layer-color').value };
  for (const k of ['x', 'y', 'width', 'height']) next[k] = Math.round(Number($('layer-' + k).value));
  if (l.type === 'TEXT') Object.assign(next, { characters: $('layer-text').value, name: $('layer-text').value.slice(0, 24) || '文字', fontFamily: $('layer-font').value.trim() || 'Arial', fontSize: Number($('layer-font-size').value) });
  if (next.type === 'TEXT' && (!next.characters.trim() || next.characters.length > 10000 || next.fontSize < 1 || next.fontSize > 2048 || !Number.isFinite(next.fontSize))) return toast('请填写原文和有效字号。');
  if (l.type === 'VECTOR') {
    try { next.vectorPaths = l.vectorPaths.map(p => ({ ...p, data: pathCommands(p.data, l.width, l.height).map(({command, values}) => command + (values.length ? ' ' + values.map((v, i) => Number((v * (i % 2 ? next.height / l.height : next.width / l.width)).toFixed(4))).join(' ') : '')).join(' ') })); } catch (error) { return toast(error.message); }
  }
  next.confidence = 1; // Applying an explicit user correction confirms this candidate, not the untouched model guesses.
  Object.assign(l, next); state.editorDirty = false; l.enabled = false; await recheck(a); changed(a); render(); toast('已重新检查，请核对后重新启用。');
};
let startPoint;
function pointerPoint(event) { const b = $('preview-canvas').getBoundingClientRect(), a = current(); return { x: Math.max(0, Math.min(a.width, Math.round((event.clientX - b.left) / b.width * a.width))), y: Math.max(0, Math.min(a.height, Math.round((event.clientY - b.top) / b.height * a.height))) }; }
$('manual-add').onclick = () => { if (!current() || state.busy || !discardDraft()) return; state.drawing = !state.drawing; state.layer = null; state.view = 'original'; render(); if (state.drawing) toast('在原图上拖出完整文字区域，不要框入其他文字或物体。'); };
$('preview-canvas').onpointerdown = e => { if (!state.drawing) return; e.preventDefault(); startPoint = pointerPoint(e); e.target.setPointerCapture(e.pointerId); };
$('preview-canvas').onpointermove = e => { if (!state.drawing || !startPoint) return; const p = pointerPoint(e); renderSelection({ x: Math.min(p.x, startPoint.x), y: Math.min(p.y, startPoint.y), width: Math.abs(p.x - startPoint.x), height: Math.abs(p.y - startPoint.y) }); };
$('preview-canvas').onpointerup = async e => {
  if (!state.drawing || !startPoint) return;
  const a = current(), p = pointerPoint(e), x = Math.min(p.x, startPoint.x), y = Math.min(p.y, startPoint.y), width = Math.abs(p.x - startPoint.x), height = Math.abs(p.y - startPoint.y);
  startPoint = null; state.drawing = false;
  if (width < 8 || height < 8) { render(); return toast('区域太小，请重新框选。'); }
  if (a.layers.length >= 200) { render(); return toast('每张图片最多200个候选图层。'); }
  const l = { id: crypto.randomUUID(), type: 'TEXT', manual: true, name: '手动文字（请填写原文）', characters: '', x, y, width, height, fontSize: Math.min(2048, Math.max(8, Math.round(height * .65))), fontFamily: 'Arial', fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, align: 'left', color: '#000000', confidence: 1, reason: '用户手动框选，原文需核对', enabled: false };
  a.layers.push(l); a.analyzed = true; state.layer = l.id; await recheck(a); changed(a); render(); $('layer-text').focus();
};
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.drawing) { state.drawing = false; startPoint = null; render(); } });
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('dialog').close();
$('help-open').onclick = () => $('help-dialog').showModal();
function syncSettings() {
  $('custom-fields').disabled = !$('custom-config').checked;
  $('server-config-note').textContent = state.server?.configured ? '服务器已配置：' + state.server.model + ' · ' + state.server.baseUrl + '。当前页面可直接使用；密钥不会返回浏览器。' : '服务器未配置可用模型。请使用自己的接口，或配置 Render 环境变量。';
  $('connection-dot').classList.toggle('ready', state.config.useCustom || !!state.server?.configured);
}
$('settings-open').onclick = () => {
  $('custom-config').checked = state.config.useCustom || !state.server?.configured;
  $('config-base').value = state.config.baseUrl || state.server?.baseUrl || 'https://api.openai.com/v1'; $('config-model').value = state.config.model || ''; $('config-key').value = state.config.key || ''; $('config-protocol').value = state.config.protocol || 'responses';
  $('config-error').textContent = ''; syncSettings(); $('settings-dialog').showModal();
};
$('custom-config').onchange = syncSettings;
$('settings-form').onsubmit = e => {
  e.preventDefault(); const custom = $('custom-config').checked;
  if (custom) {
    let url; try { url = new URL($('config-base').value.trim()); } catch { $('config-error').textContent = '接口地址无效。'; return; }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) { $('config-error').textContent = '请使用 HTTPS 或本机 HTTP Base URL，不要填写完整生成接口。'; return; }
    state.config = { useCustom: true, baseUrl: url.href.replace(/\/$/, ''), model: $('config-model').value.trim(), key: $('config-key').value.trim(), protocol: $('config-protocol').value };
    if (!state.config.model || !state.config.key) { $('config-error').textContent = '请填写模型 ID 和密钥。'; return; }
  } else { if (!state.server?.configured) { $('config-error').textContent = '服务器尚未配置模型。'; return; } state.config = { useCustom: false }; }
  $('config-key').value = ''; $('settings-dialog').close(); syncSettings(); toast('设置已应用；尚未发送图片验证。');
};
function requestAnalysis(assets) {
  if (state.busy || !assets.length) return;
  if (state.editorDirty) return toast('请先应用当前图层的修改，再开始分析。');
  if (!state.config.useCustom && !state.server?.configured) { toast('请先配置支持图片输入的视觉模型。'); $('settings-open').click(); return; }
  state.pending = assets.map(a => a.id);
  const config = state.config.useCustom ? state.config : state.server;
  $('consent-copy').textContent = '将发送 ' + assets.length + ' 张图片到 ' + config.baseUrl + '，使用模型 ' + config.model + '。服务商可能收取费用；失败不会自动重试。';
  $('consent-dialog').showModal();
}
$('analyze-one').onclick = () => requestAnalysis(current() ? [current()] : []);
$('analyze-all').onclick = () => requestAnalysis(state.assets);
function resized(c, x, y, w, h, max = 1800) { const scale = Math.min(1, max / Math.max(w, h)), target = canvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))); target.getContext('2d').drawImage(c, x, y, w, h, 0, 0, target.width, target.height); const url = target.toDataURL('image/png'); target.width = target.height = 1; return url; }
async function analysisInput(a) {
  const c = await sourceCanvas(a), image = resized(c, 0, 0, c.width, c.height), tiles = [];
  if (a.height / a.width > 2 || a.width / a.height > 2) {
    const vertical = a.height > a.width, long = vertical ? a.height : a.width, short = vertical ? a.width : a.height, count = Math.min(6, Math.ceil(long / (short * 1.3))), step = long / count;
    for (let i = 0; i < count; i++) { const from = Math.max(0, Math.floor(i * step - step * .06)), to = Math.min(long, Math.ceil((i + 1) * step + step * .06)); const x = vertical ? 0 : from, y = vertical ? from : 0, w = vertical ? short : to - from, h = vertical ? to - from : short; tiles.push({ image: resized(c, x, y, w, h), bbox: [x / a.width, y / a.height, w / a.width, h / a.height] }); }
  }
  c.width = c.height = 1; return { image, tiles, width: a.width, height: a.height, config: state.config.useCustom ? { ...state.config } : { useCustom: false } };
}
$('consent-confirm').onclick = async () => {
  $('consent-dialog').close(); if (state.busy) return; state.busy = true;
  const ids = [...state.pending]; let succeeded = 0;
  for (const id of ids) {
    const a = state.assets.find(x => x.id === id); if (!a) continue; state.selected = id; state.layer = null; a.error = ''; a.notes = '正在分析：' + a.name + '。请等待模型响应…'; render();
    try {
      const response = await fetch('/api/reconstruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await analysisInput(a)), signal: AbortSignal.timeout(200000) });
      let data; try { data = await response.json(); } catch { throw new Error('网站服务返回了非 JSON 响应，请检查部署日志；原图与候选未改动。'); }
      if (!response.ok) throw new Error(data.error || '分析失败。');
      // Re-validate server results at the browser boundary, never trust supplied checks or enabled flags.
      const normalized = normalizeResult({ layers: data.layers.map(l => inputLayer(l, a)) }, a.width, a.height);
      const previous = a.layers; a.layers = normalized;
      try { await recheck(a); } catch (error) { a.layers = previous; throw error; }
      for (const l of a.layers) if (l.check.safe) { l.enabled = true; try { enabledLayers(a.layers); } catch { l.enabled = false; l.check.reason += ' 与其他候选冲突，请只启用一项。'; } }
      a.analyzed = true; a.notes = (data.notes || '分析完成。') + '\n通过检查的文字与图形已准备为原生图层。字体为推测，照片背景为近似修补；请核对原文、路径与重影后确认。未通过检查的候选不会冒充可编辑图层。'; changed(a); succeeded++;
    } catch (error) { a.error = error.name === 'TimeoutError' ? '请求超时，未自动重试。建议先分析单个模块。' : error.message; a.notes = ''; }
    render();
  }
  state.busy = false; render(); toast('分析完成：' + succeeded + ' / ' + ids.length + ' 张成功。失败图片保留原状态。');
};
function db() { return new Promise((resolve, reject) => { const r = indexedDB.open('studio-layers-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('workspace'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function projectData() { return { schema: 'studio-layers-project/1', assets: state.assets.map(a => ({ id: a.id, name: a.name, width: a.width, height: a.height, dataUrl: a.dataUrl, layers: a.layers.map(({ check, ...l }) => l), analyzed: a.analyzed, reviewed: a.reviewed, notes: a.notes })), selected: state.selected }; }
function inputLayer(l, asset) {
  const result = { ...l, bbox: [l.x / asset.width, l.y / asset.height, l.width / asset.width, l.height / asset.height], text: l.characters };
  if (l.type === 'VECTOR') result.paths = l.vectorPaths.map(p => ({ ...p, data: pathCommands(p.data, l.width, l.height).map(({command, values}) => command + (values.length ? ' ' + values.map((n, i) => n / (i % 2 ? l.height : l.width)).join(' ') : '')).join(' ') }));
  return result;
}
async function saveProject() {
  const database = await db(); try { await new Promise((resolve, reject) => { const t = database.transaction('workspace', 'readwrite'); t.objectStore('workspace').put(projectData(), 'current'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); } finally { database.close(); }
  dirty = false; $('save-status').textContent = '已保存至当前浏览器';
}
$('save-project').onclick = async () => { if (state.busy || state.editorDirty) return toast('请等待分析完成，并应用当前图层的修改后再保存。'); try { await saveProject(); toast('项目已保存，密钥未写入。'); } catch { toast('浏览器存储失败，请下载项目备份。'); } };
function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 20000); }
function rasterTiles(c, prefix, assets) {
  const nodes = [];
  for (let y = 0; y < c.height; y += 4096) for (let x = 0; x < c.width; x += 4096) {
    const width = Math.min(4096, c.width - x), height = Math.min(4096, c.height - y), tile = canvas(width, height), assetId = prefix + '-' + nodes.length;
    tile.getContext('2d').drawImage(c, x, y, width, height, 0, 0, width, height);
    assets[assetId] = { dataUrl: tile.toDataURL('image/png') }; nodes.push({ assetId, x, y, width, height }); tile.width = tile.height = 1;
  }
  return nodes;
}
$('backup-project').onclick = () => { if (state.busy || state.editorDirty) return toast('请等待分析完成，并应用当前图层的修改后再备份。'); download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), 'studio-layers-project.json'); };
async function restore(data) {
  if (data.schema !== 'studio-layers-project/1' || !Array.isArray(data.assets) || data.assets.length > 20) throw new Error('不是当前工作台的项目备份（最多20张）。');
  const assets = [], ids = new Set();
  for (const item of data.assets) {
    if (typeof item.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(item.dataUrl) || item.dataUrl.length > 43000000) throw new Error('备份中包含无效图片。');
    dimensions(item.width, item.height);
    const a = { id: typeof item.id === 'string' && !ids.has(item.id) ? item.id : crypto.randomUUID(), name: String(item.name || 'image').slice(0, 200), width: item.width, height: item.height, dataUrl: item.dataUrl, layers: [], analyzed: !!item.analyzed, reviewed: false, notes: String(item.notes || '').slice(0,3000), error: '' };
    ids.add(a.id);
    if (!Array.isArray(item.layers)) throw new Error('备份图层列表无效。');
    a.layers = normalizeResult({ layers: item.layers.map(l => inputLayer(l, a)) }, a.width, a.height, { allowIncomplete: true });
    await recheck(a);
    a.layers.forEach((l, i) => l.enabled = !!item.layers[i].enabled && l.check.safe);
    enabledLayers(a.layers); assets.push(a);
  }
  imageCache.clear(); state.assets = assets; state.selected = assets.find(a => a.id === data.selected)?.id || assets[0]?.id; state.layer = null; state.editorDirty = false; changed(); render();
}
$('restore-project').onchange = async e => {
  try { const file = e.target.files[0]; if (!file) return; if (file.size > 180 * 1024 * 1024) throw new Error('项目超过180MB，请拆分。'); if (state.busy) throw new Error('请等待分析完成。'); if (state.assets.length && !confirm('用备份替换当前工作区？请先保存或备份当前内容。')) return; await restore(JSON.parse(await file.text())); toast('项目已恢复，请重新核对预览。'); } catch (error) { toast('恢复失败：' + error.message); } finally { e.target.value = ''; }
};
$('export-open').onclick = () => {
  if ($('export-open').disabled) return;
  const count = state.assets.reduce((n, a) => n + a.layers.filter(l => l.enabled).length, 0);
  $('export-summary').textContent = state.assets.length + ' 张原尺寸画板，' + count + ' 个可编辑原生图层。' + (count ? '复杂画面保留为图片。' : '当前未启用任何原生图层：导入后只有图片，可移动或缩放，内部内容不可编辑。');
  $('export-error').textContent = ''; $('export-dialog').showModal();
};
$('download-package').onclick = async () => {
  if (state.busy || state.editorDirty || !state.assets.every(a => a.reviewed) || !state.assets.some(a => a.layers.some(l => l.enabled))) return;
  state.busy = true; $('download-package').disabled = true; $('export-error').textContent = ''; render();
  try {
    if (!globalThis.JSZip) throw new Error('导出组件加载失败，请刷新页面。');
    const zip = new JSZip(), data = { schema: SCHEMA, boards: [], assets: {}, notes: '字体为估计值。隐藏原图用于对照；保留的复杂细节为位图。' }, manifest = [];
    for (const [index, a] of state.assets.entries()) {
      await recheck(a); const full = await builtCanvas(a);
      if (full.overflow.length) { a.reviewed = false; throw new Error(a.name + '：文字超出区域，请调整后重新核对。'); }
      const prefix = String(index + 1).padStart(2, '0'), base = await builtCanvas(a, false), original = await sourceCanvas(a), baseId = a.id + '-base', refId = a.id + '-reference';
      const originalUrl = original.toDataURL('image/png');
      data.boards.push(boardFor(a, rasterTiles(base.canvas, baseId, data.assets), rasterTiles(original, refId, data.assets)));
      zip.file('previews/' + prefix + '.png', full.canvas.toDataURL('image/png').split(',')[1], { base64: true });
      zip.file('originals/' + prefix + '.png', originalUrl.split(',')[1], { base64: true });
      manifest.push({ name: a.name, width: a.width, height: a.height, editable: a.layers.filter(l => l.enabled).map(l => ({ name: l.name, type: l.type, characters: l.characters, vectorPaths: l.vectorPaths, backgroundMethod: l.check.method, warning: l.check.reason, x: l.x, y: l.y, width: l.width, height: l.height })), retainedRaster: a.layers.filter(l => !l.enabled).map(l => ({ name: l.name, reason: l.check.reason })) });
      full.canvas.width = base.canvas.width = original.width = 1;
    }
    const json = JSON.stringify(data); if (new Blob([json]).size > 175 * 1024 * 1024) throw new Error('分层文件超过175MB，请减少图片数量后导出。');
    zip.file('figma-import.json', json); zip.file('layer-report.json', JSON.stringify(manifest, null, 2));
    for (const name of ['manifest.json', 'code.js', 'ui.html']) { const r = await fetch('/figma-plugin/' + name); if (!r.ok) throw new Error('导入插件文件下载失败。'); zip.file('figma-plugin/' + name, await r.text()); }
    zip.file('使用说明.txt', '在 Figma 桌面端：Plugins → Development → Import plugin from manifest，选择 figma-plugin/manifest.json。运行插件后选择 figma-import.json。\n原图为隐藏锁定层；清底图保留复杂细节；启用项为独立原生图层。\n请核对字体替换、文字换行、遗漏和重影。此工具不恢复完整原始源文件。');
    download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), 'studio-layers-figma.zip'); toast('导入包已生成。请在 Figma 导入后再次核对字体和换行。');
  } catch (error) { $('export-error').textContent = error.message; } finally { state.busy = false; $('download-package').disabled = false; render(); }
};
window.addEventListener('beforeunload', e => { if (dirty || state.busy) { e.preventDefault(); e.returnValue = ''; } });
async function init() {
  try { const r = await fetch('/api/status'); if (!r.ok) throw new Error(); state.server = (await r.json()).vision; } catch { toast('无法读取服务器状态。请通过网站服务访问，不要直接打开 HTML 文件。'); }
  try { const database = await db(); const data = await new Promise((resolve, reject) => { const r = database.transaction('workspace').objectStore('workspace').get('current'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); database.close(); if (data) { await restore(data); dirty = false; $('save-status').textContent = '已恢复本地项目 · 请重新核对'; } } catch { toast('本地项目未能恢复，请从备份导入。'); }
  syncSettings(); render();
}
void init();

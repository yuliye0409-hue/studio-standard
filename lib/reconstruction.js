// Shared, deterministic validation. Model suggestions never authorize pixel removal.
export const SCHEMA = 'studio-reconstruction/1';
export function color(value) {
  if (typeof value !== 'string') throw new Error('颜色必须为十六进制或 RGB。');
  const s = value.trim();
  if (/^#[\da-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(s)) return '#' + [...s.slice(1)].map(x => x + x).join('').toLowerCase();
  const rgb = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb && rgb.slice(1).every(x => Number(x) <= 255)) return '#' + rgb.slice(1).map(x => Number(x).toString(16).padStart(2, '0')).join('');
  throw new Error('颜色格式无效。');
}
const rgb = hex => [1, 3, 5].map(i => parseInt(color(hex).slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(...a.slice(0, 3).map((v, i) => v - b[i]));
const finite = n => typeof n === 'number' && Number.isFinite(n);
export function dimensions(width, height) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) || width * height > 32000000) throw new Error('图片最大边长为 16384px，总像素不能超过 3200 万。');
}
export function normalizeResult(result, width, height, { allowIncomplete = false } = {}) {
  dimensions(width, height);
  if (!result || !Array.isArray(result.layers) || result.layers.length > 200) throw new Error('模型结果缺少有效 layers 列表（最多 200 项）。');
  return result.layers.map((item, index) => {
    if (!item || !['TEXT', 'RECTANGLE', 'ELLIPSE'].includes(item.type)) throw new Error(`第 ${index + 1} 个图层类型无效。`);
    const b = item.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(finite) || b.some(n => n < 0 || n > 1) || !b[2] || !b[3] || b[0] + b[2] > 1.00001 || b[1] + b[3] > 1.00001) throw new Error(`第 ${index + 1} 个图层边界无效。`);
    if (!finite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('图层置信度无效。');
    if (item.type === 'TEXT' && (typeof item.text !== 'string' || (!item.text.trim() && !(allowIncomplete && item.manual === true)) || item.text.length > 10000)) throw new Error('文字图层缺少可核对的原文。');
    const x = Math.round(b[0] * width), y = Math.round(b[1] * height);
    const layer = { id: `layer-${index + 1}`, type: item.type, name: String(item.name || (item.type === 'TEXT' ? item.text.slice(0, 24) : '形状')).slice(0, 80), x, y, width: Math.min(width - x, Math.max(1, Math.round(b[2] * width))), height: Math.min(height - y, Math.max(1, Math.round(b[3] * height))), color: color(item.color), confidence: item.confidence, reason: String(item.reason || '').slice(0, 500), enabled: false };
    if (item.type === 'TEXT') {
      if (!finite(item.fontSize) || item.fontSize < 1 || item.fontSize > 2048) throw new Error('文字图层字号无效，应为原图像素值。');
      Object.assign(layer, { characters: item.text, fontFamily: typeof item.fontFamily === 'string' && item.fontFamily.trim() ? item.fontFamily.trim().slice(0, 100) : 'Arial', fontSize: item.fontSize, fontWeight: [400, 500, 600, 700, 800, 900].includes(item.fontWeight) ? item.fontWeight : 400, lineHeight: finite(item.lineHeight) && item.lineHeight >= 1 && item.lineHeight <= 3 ? item.lineHeight : 1.2, align: ['left', 'center', 'right'].includes(item.align) ? item.align : 'left', letterSpacing: 0 });
    }
    if (allowIncomplete && item.manual === true) layer.manual = true;
    return layer;
  });
}
export function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
// A conservative two-color test: protects photographic details and unknown backdrops.
export function inspectRegion(pixels, width, height, layer) {
  const fail = reason => ({ safe: false, reason });
  if (layer.type === 'TEXT' && (typeof layer.characters !== 'string' || !layer.characters.trim() || layer.characters.length > 10000)) return fail('请先完整填写并应用原文，空文字不能替换原图内容。');
  const shape = layer.type !== 'TEXT';
  const padding = shape ? 3 : 0;
  const { x, y, width: w, height: h } = { x: layer.x - padding, y: layer.y - padding, width: layer.width + padding * 2, height: layer.height + padding * 2 };
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 3 || h < 3 || x + w > width || y + h > height) return fail('区域越界或太小。');
  if (w * h > 4000000) return fail('区域过大，请分成更小的文字或形状区域。');
  if (layer.confidence < .75) return fail('模型置信度较低，保留为原图。可手动画区并核对原文。');
  const at = (px, py) => { const i = (py * width + px) * 4; return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]; };
  const border = [];
  for (let px = x; px < x + w; px++) { border.push(at(px, y), at(px, y + h - 1)); }
  for (let py = y + 1; py < y + h - 1; py++) { border.push(at(x, py), at(x + w - 1, py)); }
  const buckets = new Map();
  for (const p of border) { const k = p.slice(0, 3).map(v => Math.round(v / 8)).join(','); const bucket = buckets.get(k) || []; bucket.push(p); buckets.set(k, bucket); }
  const dominant = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
  const background = [0, 1, 2].map(i => Math.round(dominant.reduce((n, p) => n + p[i], 0) / dominant.length));
  if (border.filter(p => p[3] === 255 && distance(p, background) <= 14).length / border.length < .985) return fail('边缘不是连续纯色底，或文字未被完整框住。请调整区域；复杂背景保留原图。');
  let foreground;
  try { foreground = rgb(layer.color); } catch { return fail('请填写有效的文字或形状颜色。'); }
  const vector = foreground.map((v, i) => v - background[i]), norm = vector.reduce((n, v) => n + v * v, 0);
  if (norm < 1600) return fail('前景与背景太接近，无法可靠提取。');
  let explained = 0, blank = 0, ink = 0, opaque = 0, geometryErrors = 0;
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
    const p = at(px, py); if (p[3] === 255) opaque++;
    const t = Math.max(0, Math.min(1, p.slice(0, 3).reduce((n, v, i) => n + (v - background[i]) * vector[i], 0) / norm));
    const expected = background.map((v, i) => v + vector[i] * t);
    if (distance(p, expected) <= 18) explained++;
    if (distance(p, background) <= 14) blank++;
    if (t > .5) ink++;
    if (shape) {
      const lx = px + .5 - layer.x, ly = py + .5 - layer.y;
      let inside, edge;
      if (layer.type === 'RECTANGLE') {
        inside = lx >= 0 && ly >= 0 && lx < layer.width && ly < layer.height;
        edge = Math.min(Math.abs(lx), Math.abs(ly), Math.abs(lx - layer.width), Math.abs(ly - layer.height)) < 1.5;
      } else {
        const radius = Math.hypot((lx - layer.width / 2) / (layer.width / 2), (ly - layer.height / 2) / (layer.height / 2));
        inside = radius <= 1; edge = Math.abs(radius - 1) * Math.min(layer.width, layer.height) / 2 < 1.5;
      }
      if (!edge && distance(p, inside ? foreground : background) > 18) geometryErrors++;
    }
  }
  const total = w * h;
  if (opaque !== total || explained / total < .995 || blank / total < (shape ? .01 : .3) || ink / total < .002) return fail('区域含照片、渐变、其他颜色或未识别内容，无法用纯色清底。保留为原图。');
  if (shape && geometryErrors > Math.max(1, total * .0005)) return fail('原图与简单形状边界不一致，可能含圆角、描边或其他元素。保留为原图。');
  return { safe: true, patch: { x, y, width: w, height: h }, background: '#' + background.map(v => v.toString(16).padStart(2, '0')).join(''), reason: shape ? '通过纯色与形状边界检查。启用后改为独立形状，仍需对照核对。' : '通过纯色背景与双色像素检查；启用后清除区域内原文字，改为独立文字层。仍需核对原文、范围和字体。' };
}
export function enabledLayers(layers) {
  const enabled = layers.filter(l => l.enabled);
  for (const layer of enabled) {
    if (!layer.check?.safe) throw new Error('存在未通过背景检查的启用图层。');
    if (enabled.some(other => other !== layer && intersects(layer.check.patch || layer, other.check.patch || other))) throw new Error('启用的提取区域相互重叠，请只保留一个或调整边界。');
  }
  return enabled;
}
export function boardFor(asset, baseId, referenceId) {
  const layers = enabledLayers(asset.layers);
  const raster = (input, original) => (Array.isArray(input) ? input : [{ assetId: input, x: 0, y: 0, width: asset.width, height: asset.height }]).map((tile, i) => ({ id: (original ? 'original-' : 'base-') + i, type: 'IMAGE', name: original ? '原图对照（隐藏、锁定）' : '保留的照片与复杂细节（位图）', ...tile, hash: '', ...(original ? { visible: false } : {}), locked: true }));
  return { id: asset.id, name: asset.name, width: asset.width, height: asset.height, nodes: [
    ...raster(referenceId, true), ...raster(baseId, false),
    ...layers.map(({ check, enabled, confidence, reason, ...layer }) => layer)
  ] };
}

// Shared, deterministic validation. Model suggestions never authorize pixel removal.
export const SCHEMA = 'studio-reconstruction/2';
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
    if (!item || !['TEXT', 'RECTANGLE', 'ELLIPSE', 'VECTOR'].includes(item.type)) throw new Error(`第 ${index + 1} 个图层类型无效。`);
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
    if (item.type === 'VECTOR') {
      layer.vectorPaths = normalizePaths(item.paths, layer.width, layer.height);
      layer.filled = item.filled !== false;
      layer.strokeWidth = finite(item.strokeWidth) && item.strokeWidth > 0 && item.strokeWidth <= 100 ? item.strokeWidth : (layer.filled ? 0 : 2);
      if (layer.filled && layer.vectorPaths.some(p => p.windingRule === 'NONE' || !p.data.endsWith('Z'))) throw new Error('填充矢量路径必须闭合且包含有效填充规则。');
    }
    if (allowIncomplete && item.manual === true) layer.manual = true;
    return layer;
  });
}
export function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
// A conservative two-color test: protects photographic details and unknown backdrops.
function inspectFlatRegion(pixels, width, height, layer) {
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
  return { safe: true, method: 'fill', patch: { x, y, width: w, height: h }, background: '#' + background.map(v => v.toString(16).padStart(2, '0')).join(''), reason: shape ? '通过纯色与形状边界检查。启用后改为独立形状，仍需对照核对。' : '通过纯色背景与双色像素检查；启用后清除区域内原文字，改为独立文字层。仍需核对原文、范围和字体。' };
}
// Deliberately small SVG path grammar. Coordinates are local to the layer, never executable SVG.
export function pathCommands(data, width = 1, height = 1) {
  if (typeof data !== 'string' || data.length > 20000 || /[^MLQCZ\d\s.,+eE-]/.test(data)) throw new Error('矢量路径格式无效，只支持 M/L/Q/C/Z。');
  const tokens = data.match(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  const commands = []; let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++], count = { M: 2, L: 2, Q: 4, C: 6, Z: 0 }[command];
    if (count === undefined || commands.length > 1500) throw new Error('矢量路径命令无效。');
    const values = tokens.slice(i, i + count).map(Number); i += count;
    if (values.length !== count || values.some((n, j) => !finite(n) || n < 0 || n > (j % 2 ? height : width) + .00001)) throw new Error('矢量路径坐标越界。');
    commands.push({ command, values });
  }
  if (commands.length < 2 || commands[0].command !== 'M') throw new Error('矢量路径必须从 M 开始。');
  return commands;
}
export function normalizePaths(paths, width, height) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 32) throw new Error('缺少有效矢量路径。');
  return paths.map(path => ({ windingRule: ['EVENODD', 'NONZERO', 'NONE'].includes(path.windingRule) ? path.windingRule : 'EVENODD', data: pathCommands(path.data).map(({ command, values }) => command + (values.length ? ' ' + values.map((n, i) => Number((n * (i % 2 ? height : width)).toFixed(4))).join(' ') : '')).join(' ') }));
}
function contours(layer) {
  const result = [];
  for (const path of layer.vectorPaths) {
    const subpaths=[];let points = [], last = [0, 0];
    for (const { command, values: v } of pathCommands(path.data, layer.width, layer.height)) {
      if (command === 'M') { if (points.length) subpaths.push(points); points = [[...v]]; last = v; }
      if (command === 'L') { points.push(v); last = v; }
      if (command === 'Q' || command === 'C') {
        const start = last;
        for (let step = 1; step <= 24; step++) {
          const t = step / 24, s = 1 - t;
          points.push([0, 1].map(k => command === 'Q' ? s * s * start[k] + 2 * s * t * v[k] + t * t * v[k + 2] : s ** 3 * start[k] + 3 * s * s * t * v[k] + 3 * s * t * t * v[k + 2] + t ** 3 * v[k + 4]));
        }
        last = v.slice(-2);
      }
      if (command === 'Z' && points.length) points.push(points[0]);
    }
    if (points.length) subpaths.push(points);
    result.push({subpaths,windingRule:path.windingRule});
  }
  return result;
}
function insideVector(paths, x, y, strokeWidth, filled) {
  for (const path of paths) {
    let winding=0,crossings=0;
    for (const points of path.subpaths) for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) {crossings++;winding+=by>ay?1:-1;}
      if (strokeWidth) {
        const d = (bx - ax) ** 2 + (by - ay) ** 2, t = d ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / d)) : 0;
        if (Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= strokeWidth / 2 + 1) return true;
      }
    }
    if(filled && path.windingRule!=='NONE' && (path.windingRule==='NONZERO'?winding!==0:crossings%2===1))return true;
  }
  return false;
}
export function inspectRegion(pixels, width, height, layer) {
  const flat = layer.type === 'VECTOR' ? { safe: false, reason: '矢量区域需要像素检查。' } : inspectFlatRegion(pixels, width, height, layer);
  if (flat.safe || /原图与简单形状/.test(flat.reason)) return flat;
  const fail = reason => ({ safe: false, reason });
  if (layer.type === 'TEXT' && !layer.characters?.trim()) return flat;
  const { x, y, width: w, height: h } = layer;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 3 || h < 3 || x + w > width || y + h > height || w * h > 4000000) return fail('区域越界、太小或超过 400 万像素，请调整范围。');
  if (layer.confidence < .75) return fail('模型置信度较低，请核对原文和范围后应用修改。');
  const foreground = rgb(layer.color), mask = new Uint8Array(w * h), paths = layer.type === 'VECTOR' ? contours(layer) : null, shape = layer.type !== 'TEXT';
  let ink = 0, geometry = 0;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const i = ((y + py) * width + x + px) * 4;
    if (pixels[i + 3] !== 255) return fail('区域含透明像素，无法自动修补背景。');
    const candidate = paths ? insideVector(paths, px + .5, py + .5, layer.strokeWidth, layer.filled) : layer.type === 'ELLIPSE' ? Math.hypot((px + .5 - w / 2) / (w / 2), (py + .5 - h / 2) / (h / 2)) <= 1 : true;
    if (candidate) geometry++;
    if (candidate && Math.hypot(pixels[i] - foreground[0], pixels[i + 1] - foreground[1], pixels[i + 2] - foreground[2]) <= 55) { mask[py * w + px] = 1; ink++; }
  }
  if (ink < Math.max(3, w * h * .002) || (!shape && ink > w * h * .65) || (shape && ink < geometry * .6)) return fail('区域中没有足够匹配的文字或图形像素，请核对颜色、路径与范围。');
  if (!shape) {
    const edges = [Array.from({length:w},(_,x)=>mask[x]),Array.from({length:w},(_,x)=>mask[(h-1)*w+x]),Array.from({length:h},(_,y)=>mask[y*w]),Array.from({length:h},(_,y)=>mask[y*w+w-1])];
    if (edges.some(edge=>edge.reduce((n,v)=>n+v,0)>edge.length*.3)) return fail('文字贴近或超出边界，请扩大文字框，避免残留被截断的字。');
  }
  // Cover antialias fringes as well. Validation above must find real matching foreground first.
  const expanded = mask.slice();
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) if (mask[py * w + px]) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (px + dx >= 0 && px + dx < w && py + dy >= 0 && py + dy < h) expanded[(py + dy) * w + px + dx] = 1;
  }
  // Reconstruct the complete text box: glyph-only fills visibly preserve letter-shaped smooth patches
  // on textures even when every dark pixel was removed. Keep the box tight and disclose the tradeoff.
  if (layer.type === 'TEXT') expanded.fill(1);
  return { safe: true, method: 'inpaint', patch: { x, y, width: w, height: h }, mask: expanded, reason: '可重建为独立图层；文字框/图形区域由邻域近似修补，可能损失局部纹理。请核对原文、字体、路径及修补区域；不代表恢复被遮挡的原背景。' };
}
// Approximate local background reconstruction. Original bytes remain in a hidden reference layer.
export function cleanRaster(pixels, width, height, layers) {
  const out = new Uint8ClampedArray(pixels), mask = new Uint8Array(width * height);
  for (const l of layers) {
    const p = l.check.patch;
    if (l.check.method === 'inpaint') {
      for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (l.check.mask[y * p.width + x]) mask[(p.y + y) * width + p.x + x] = 1;
    } else {
      const c = rgb(l.check.background);
      for (let y = p.y; y < p.y + p.height; y++) for (let x = p.x; x < p.x + p.width; x++) { const i = (y * width + x) * 4; out.set([...c, 255], i); }
    }
  }
  const selected = []; for (let i=0;i<mask.length;i++) if(mask[i]) selected.push(i);
  if (!selected.length) return out;
  if(selected.length===mask.length)throw new Error('修补区域覆盖整张图片，没有可用背景样本；请缩小范围或关闭候选。');
  // Solve a low-resolution harmonic field first. A simple nearest-edge flood leaves glyph-shaped seams.
  const step=16,cw=Math.ceil(width/step),ch=Math.ceil(height/step),coarse=new Float32Array(cw*ch*3),known=new Uint16Array(cw*ch),unknown=new Uint8Array(cw*ch);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=y*width+x,j=Math.floor(y/step)*cw+Math.floor(x/step);
    if(mask[i])unknown[j]=1;
    else {known[j]++;for(let c=0;c<3;c++)coarse[j*3+c]+=out[i*4+c];}
  }
  for(let j=0;j<known.length;j++) {
    const area=Math.min(step,width-(j%cw)*step)*Math.min(step,height-Math.floor(j/cw)*step);
    if(known[j]>=area*.35)unknown[j]=0; // Keep useful boundary samples instead of expanding a small mask to the image edge.
    for(let c=0;c<3;c++)coarse[j*3+c]=known[j]?coarse[j*3+c]/known[j]:128;
  }
  const neighbors=(i,w,h)=>[i%w?i-1:-1,i%w<w-1?i+1:-1,i>=w?i-w:-1,i<w*(h-1)?i+w:-1].filter(n=>n>=0);
  const pending=unknown.slice(),queue=[];
  for(let j=0;j<pending.length;j++)if(pending[j]&&neighbors(j,cw,ch).some(n=>!pending[n])){pending[j]=2;queue.push(j);}
  for(let cursor=0;cursor<queue.length;cursor++) {
    const j=queue[cursor],near=neighbors(j,cw,ch),ready=near.filter(n=>!pending[n]);
    if(!ready.length)continue;
    for(let c=0;c<3;c++)coarse[j*3+c]=ready.reduce((sum,n)=>sum+coarse[n*3+c],0)/ready.length;
    pending[j]=0;for(const n of near)if(pending[n]===1){pending[n]=2;queue.push(n);}
  }
  for(let pass=0;pass<120;pass++)for(const j of queue) {
    const near=neighbors(j,cw,ch);for(let c=0;c<3;c++)coarse[j*3+c]=near.reduce((sum,n)=>sum+coarse[n*3+c],0)/near.length;
  }
  for(const i of selected) {
    const fx=Math.max(0,Math.min(cw-1,(i%width+.5)/step-.5)),fy=Math.max(0,Math.min(ch-1,(Math.floor(i/width)+.5)/step-.5)),x=Math.floor(fx),y=Math.floor(fy),a=fx-x,b=fy-y;
    for(let c=0;c<3;c++) {const at=(x,y)=>coarse[(y*cw+x)*3+c];out[i*4+c]=(at(x,y)*(1-a)+at(Math.min(cw-1,x+1),y)*a)*(1-b)+(at(x,Math.min(ch-1,y+1))*(1-a)+at(Math.min(cw-1,x+1),Math.min(ch-1,y+1))*a)*b;}
  }
  // Relax only masked pixels; every unselected photographic pixel stays byte-for-byte unchanged.
  const field=new Float32Array(selected.length*3);
  for(let pass=0;pass<12;pass++) {
    for(let k=0;k<selected.length;k++) {const near=neighbors(selected[k],width,height);for(let c=0;c<3;c++)field[k*3+c]=near.reduce((sum,n)=>sum+out[n*4+c],0)/near.length;}
    for(let k=0;k<selected.length;k++)for(let c=0;c<3;c++)out[selected[k]*4+c]=field[k*3+c];
  }
  return out;
}
const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
export function enabledLayers(layers) {
  const enabled = layers.filter(l => l.enabled);
  for (const layer of enabled) {
    if (!layer.check?.safe) throw new Error('存在未通过背景检查的启用图层。');
    if (enabled.some(other => other !== layer && intersects(layer, other) && !((layer.type !== 'TEXT' && other.type === 'TEXT' && contains(layer, other)) || (other.type !== 'TEXT' && layer.type === 'TEXT' && contains(other, layer))))) throw new Error('启用的提取区域相互重叠，请只保留一个或调整边界。');
  }
  return enabled.sort((a, b) => Number(a.type === 'TEXT') - Number(b.type === 'TEXT'));
}
export function boardFor(asset, baseId, referenceId) {
  const layers = enabledLayers(asset.layers);
  const raster = (input, original) => (Array.isArray(input) ? input : [{ assetId: input, x: 0, y: 0, width: asset.width, height: asset.height }]).map((tile, i) => ({ id: (original ? 'original-' : 'base-') + i, type: 'IMAGE', name: original ? '原图对照（隐藏、锁定）' : '保留的照片与复杂细节（位图）', ...tile, hash: '', ...(original ? { visible: false } : {}), locked: true }));
  return { id: asset.id, name: asset.name, width: asset.width, height: asset.height, nodes: [
    ...raster(referenceId, true), ...raster(baseId, false),
    ...layers.map(({ check, enabled, confidence, reason, ...layer }) => layer)
  ] };
}

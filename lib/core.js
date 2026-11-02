import { parse, stringify } from 'yaml';

export const SCHEMA = 'studio-standard/2';
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const uid = () => globalThis.crypto.randomUUID();
export const safeName = value => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) || 'design';
export const number = (value, fallback) => Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback;

export function rgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}
export function toHex(values) { return '#' + values.map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join(''); }
export function luminance(color) {
  const linear = rgb(color).map(n => n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4);
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}
export function contrast(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((a, b) => b - a); return (hi + .05) / (lo + .05); }
export const readable = background => contrast(background, '#ffffff') > contrast(background, '#1d1d1f') ? '#ffffff' : '#1d1d1f';

const roleNames = new Set(['headline', 'body', 'price', 'product', 'decorative', 'unknown']);
const box = (x, y, width, height, confidence = .5, source = 'inferred') => ({ x: Number(clamp(x, 0, 1).toFixed(4)), y: Number(clamp(y, 0, 1).toFixed(4)), width: Number(clamp(width, 0, 1).toFixed(4)), height: Number(clamp(height, 0, 1).toFixed(4)), confidence: Number(clamp(confidence, 0, 1).toFixed(2)), source });

const moduleType = (items, order, height) => {
  const text = items.map(item => item.text || '').join(' ').toLowerCase();
  const xs = items.map(item => item.bbox.x + item.bbox.width / 2);
  const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  if (order === 1) return 'hero';
  if (/fn\s*[+−-]|f1\s*[-–]?f12|win|mac|shortcut|media control/.test(text)) return 'shortcut-comparison';
  if (/support|coverage|brand care|always here|contact|@/.test(text)) return 'closing-panel';
  if (items.length >= 4 && spread > .45) return 'feature-grid';
  if (spread > .28 || items.some(item => item.role === 'product')) return 'image-text-split';
  return height > .18 ? 'feature-panel' : 'detail-panel';
};

const moduleTemplate = (type, items) => {
  const hasProduct = items.some(item => item.role === 'product');
  const textSlots = items.filter(item => item.role !== 'product').slice(0, 12).map((item, index) => ({ id: `text-${index + 1}`, role: item.role, bbox: item.bbox, maxLines: item.role === 'headline' ? 2 : 4, required: item.role === 'headline' }));
  const imageSlots = hasProduct ? [{ id: 'image-1', role: 'product', bbox: items.find(item => item.role === 'product').bbox, preserveOriginal: true, contain: true, crop: false }] : [];
  return { type, imageSlots, textSlots, spacing: { padding: .04, gap: .025 }, background: 'inherit', reuse: { replaceImagesOnly: true, preserveSlotGeometry: true, preserveCopyExactly: true } };
};

const normalizeModelSlots = (slots, prefix, fallbackRole) => (Array.isArray(slots) ? slots : []).slice(0, 20).map((slot, index) => {
  const [x, y, width, height] = Array.isArray(slot.bbox) ? slot.bbox.map(Number) : [];
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return null;
  return { id: slot.id || `${prefix}-${index + 1}`, role: slot.role || fallbackRole, bbox: box(x, y, width, height, slot.confidence ?? .5, 'vision'), ...(prefix === 'text' ? { maxLines: Number(slot.maxLines) || (slot.role === 'headline' ? 2 : 4), required: Boolean(slot.required) } : { preserveOriginal: true, contain: true, crop: false }) };
}).filter(Boolean);

function modelAPlusModules(reference) {
  if (!Array.isArray(reference.aPlusModules) || !reference.aPlusModules.length) return null;
  const modules = reference.aPlusModules.slice(0, 40).flatMap((module, index) => {
    const [x, y, width, height] = Array.isArray(module.bbox) ? module.bbox.map(Number) : [];
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return [];
    const type = String(module.type || 'feature-panel').slice(0, 64);
    const confidence = Number.isFinite(Number(module.confidence)) ? Number(module.confidence) : .5;
    return [{ id: `module-${index + 1}`, order: index + 1, type, x, y, width, height, confidence: Number(clamp(confidence, 0, 1).toFixed(2)), source: 'vision', reason: String(module.reason || ''), template: { type, imageSlots: normalizeModelSlots(module.imageSlots, 'image', 'product'), textSlots: normalizeModelSlots(module.textSlots, 'text', 'body'), spacing: { padding: .04, gap: .025 }, background: 'inherit', reuse: { replaceImagesOnly: true, preserveSlotGeometry: true, preserveCopyExactly: true } } }];
  });
  return modules.length ? modules : null;
}

/** Infer reusable A+ modules from model boxes or conservative OCR evidence. */
export function extractAPlusModules(reference) {
  const evidence = reference?.evidence || extractLayoutEvidence(reference);
  const modelModules = modelAPlusModules(reference || {});
  if (modelModules) return { version: 'a-plus-layout/1', type: 'long-form-amazon-a-plus', source: reference.hash, canvas: { width: reference.width, height: reference.height }, moduleCount: modelModules.length, reviewRequired: modelModules.some(module => module.confidence < .6), modules: modelModules, rules: { preserveOrder: true, preserveImageRatio: true, containByDefault: true, allowCrop: false, allowStretch: false, rewriteCopy: false, requireReviewBeforeExport: true } };
  const elements = evidence.elements || [];
  const anchors = elements.filter(item => item.role !== 'decorative' && item.bbox.height > .0005).sort((a, b) => a.bbox.y - b.bbox.y);
  const boundaries = [0];
  const heights = anchors.map(item => item.bbox.height).filter(height => height > 0).sort((a, b) => a - b);
  const lineHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const gapThreshold = Math.max(.025, lineHeight * 3);
  for (let i = 1; i < anchors.length; i++) {
    const previous = anchors[i - 1].bbox;
    const current = anchors[i].bbox;
    const gap = current.y - (previous.y + previous.height);
    if (gap > gapThreshold && current.y - boundaries.at(-1) > Math.max(.07, lineHeight * 4)) boundaries.push(Number(current.y.toFixed(4)));
  }
  boundaries.push(1);
  const modules = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const y = boundaries[i], bottom = boundaries[i + 1], height = bottom - y;
    const items = elements.filter(item => item.bbox.y < bottom && item.bbox.y + item.bbox.height > y).map(item => ({ ...item, bbox: { ...item.bbox, y: clamp((item.bbox.y - y) / height, 0, 1), height: clamp(item.bbox.height / height, 0, 1) } }));
    if (!items.length && height < .04) continue;
    const type = items.length ? moduleType(items, modules.length + 1, height) : 'unclassified';
    const confidence = items.length ? Math.min(...items.map(item => item.bbox.confidence)) : .15;
    modules.push({ id: `module-${modules.length + 1}`, order: modules.length + 1, type, x: 0, y, width: 1, height, confidence: Number(confidence.toFixed(2)), source: items.length ? 'ocr-gap-candidate' : 'unsegmented-image', reason: items.length ? '根据 OCR 文本垂直间距估计；请人工确认模块边界。' : '未检测到可靠模块边界，整张参考图暂作为一个待确认模块。', template: moduleTemplate(type, items) });
  }
  return { version: 'a-plus-layout/1', type: 'long-form-amazon-a-plus', source: reference.hash, canvas: { width: reference.width, height: reference.height }, moduleCount: modules.length, reviewRequired: modules.some(module => module.confidence < .6), modules, rules: { preserveOrder: true, preserveImageRatio: true, containByDefault: true, allowCrop: false, allowStretch: false, rewriteCopy: false, requireReviewBeforeExport: true } };
}

export function buildAPlusSpec(references) {
  const modules = references.flatMap((reference, index) => {
    const spec = extractAPlusModules(reference);
    return spec.modules.map(module => ({ ...module, sourceReference: reference.name, sourceReferenceIndex: index }));
  });
  return { version: 'a-plus-system/1', type: 'long-form-amazon-a-plus', referenceCount: references.length, modules, reviewRequired: modules.some(module => module.confidence < .6), export: { preserveOrder: true, requireReviewBeforeExport: true, formats: ['png', 'jpg', 'project-json', 'figma-json'] } };
}

/**
 * Turns measurements into an evidence map. This is deliberately separate from
 * prose: every inferred rule has coordinates, confidence and a source that can
 * be corrected by a human before it drives the layout compiler.
 */
export function extractLayoutEvidence(reference) {
  if (!reference?.analysis) throw new Error('必须先完成像素测量才能提取版面证据。');
  const lines = reference.ocr?.lines || [];
  const elements = lines.map((line, index) => {
    const b = line.bbox || { x0: 0, y0: 0, x1: 1, y1: 1 };
    const relative = line.relativeHeight || Math.max(0, b.y1 - b.y0) / Math.max(1, reference.height);
    const role = relative >= .055 ? 'headline' : /[¥$€£]|\d{2,}/.test(line.text || '') ? 'price' : 'body';
    return { id: `text-${index + 1}`, role, text: String(line.text || ''), bbox: box(b.x0 / reference.width, b.y0 / reference.height, (b.x1 - b.x0) / reference.width, (b.y1 - b.y0) / reference.height, Math.min(1, (line.confidence || 0) / 100), 'ocr') };
  });
  const g = reference.analysis.grid || [];
  const occupied = [];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < (g[y] || []).length; x++) if (g[y][x] > .08) occupied.push({ x, y, value: g[y][x] });
  if (occupied.length && reference.height / Math.max(1, reference.width) <= 2) {
    const minX = Math.min(...occupied.map(p => p.x)), maxX = Math.max(...occupied.map(p => p.x)), minY = Math.min(...occupied.map(p => p.y)), maxY = Math.max(...occupied.map(p => p.y));
    const image = box(minX / 6, minY / 6, (maxX - minX + 1) / 6, (maxY - minY + 1) / 6, .38, 'pixel-occupancy');
    if (image.width > .16 && image.height > .16) elements.push({ id: 'visual-1', role: 'product', text: '', bbox: image });
  }
  const textElements = elements.filter(e => e.role !== 'product');
  const left = textElements.length ? textElements.reduce((n, e) => n + e.bbox.x, 0) / textElements.length : reference.analysis.centroid.x;
  const top = textElements.length ? Math.min(...textElements.map(e => e.bbox.y)) : .1;
  return {
    version: 'layout-evidence/1',
    source: reference.hash,
    elements,
    layout: { align: left < .38 ? 'left' : 'center', topContent: Number(top.toFixed(3)), safeArea: Number(Math.max(.025, Math.min(.18, Math.min(left, 1 - left))).toFixed(3)), imageFraction: Number(Math.max(.3, Math.min(.72, reference.analysis.occupancy || .55)).toFixed(3)) },
    manualReview: elements.length === 0 || elements.some(e => e.bbox.confidence < .6),
  };
}

export function buildDesignSystem(references, vision = null) {
  const evidence = references.map(reference => ({ name: reference.name, hash: reference.hash, dimensions: { width: reference.width, height: reference.height }, analysis: reference.analysis, evidence: reference.evidence || extractLayoutEvidence(reference) }));
  return { version: 'design-system/1', method: vision ? 'multimodal+measurement+human-review' : 'measurement+ocr+human-review', confidence: vision ? 'model output is a hypothesis; confirm all tokens' : 'OCR and pixel evidence; semantic interpretation pending review', references: evidence, vision: vision || null };
}

export function parseDesignMd(md) {
  const match = String(md).replace(/^\uFEFF/, '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) throw new Error('规范需要以 --- 开始的 YAML 参数区。请导入原规范或使用分析生成的 MD。');
  const doc = parse(match[1], { maxAliasCount: 20 });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('规范参数区必须是一个对象。');
  const colors = doc.colors || {};
  const resolve = (value, fallback, depth = 0) => {
    if (depth > 8) throw new Error('设计令牌存在循环引用。');
    if (typeof value !== 'string') return fallback;
    const ref = value.match(/^\{colors\.([^}]+)\}$/);
    if (ref) return resolve(colors[ref[1]], fallback, depth + 1);
    if (!/^#[\da-f]{3}([\da-f]{3})?$/i.test(value)) throw new Error(`无效的颜色值：${value}。请使用 #RRGGBB。`);
    return toHex(rgb(value));
  };
  const background = resolve(colors.canvas || colors.background || colors.surface, '#ffffff');
  const foreground = resolve(colors.ink || colors.text || colors.body, readable(background));
  const accent = resolve(colors.primary || colors.accent, foreground);
  const typography = doc.typography || {};
  const title = typography['hero-display'] || typography.display || typography.heading || Object.values(typography)[0] || {};
  const body = typography.body || typography['body-md'] || typography.lead || {};
  const layout = doc.layout || {};
  let mode = layout.mode || 'stack';
  if (!['stack', 'split', 'image-top'].includes(mode)) throw new Error('layout.mode 仅支持 stack、split、image-top。');
  const titleSize = number(title.fontSize, 80), bodySize = number(body.fontSize, 32);
  if (titleSize < 10 || titleSize > 300 || bodySize < 8 || bodySize > 160) throw new Error('字号超出可排版范围。标题 10–300px，正文 8–160px。');
  const tokens = {
    name: String(doc.name || '未命名规范'),
    colors: { background, foreground, accent, muted: resolve(colors.muted || colors['ink-muted-48'], foreground) },
    typography: {
      title: { family: String(title.fontFamily || 'Inter'), size: titleSize, weight: clamp(number(title.fontWeight, 600), 100, 900), lineHeight: clamp(number(title.lineHeight, 1.16), 1, 2), letterSpacing: number(title.letterSpacing, 0) },
      body: { family: String(body.fontFamily || title.fontFamily || 'Inter'), size: bodySize, weight: clamp(number(body.fontWeight, 400), 100, 900), lineHeight: clamp(number(body.lineHeight, 1.47), 1, 2.5), letterSpacing: number(body.letterSpacing, 0) },
    },
    layout: { mode, align: layout.align === 'left' ? 'left' : 'center', padding: clamp(number(layout.padding, .065), .025, .18), gap: clamp(number(layout.gap, .025), .01, .08), imageFraction: clamp(number(layout.imageFraction, .55), .3, .72) },
    baseWidth: clamp(number(layout.baseWidth, 1080), 320, 4096),
  };
  const warnings = [];
  if (contrast(background, foreground) < 4.5) warnings.push('正文与背景对比度低于 4.5:1，请确认是否调整文字色。');
  const aPlus = doc.aPlus || doc.aplus || null;
  if (aPlus?.modules && !Array.isArray(aPlus.modules)) throw new Error('aPlus.modules 必须是数组。');
  if (aPlus?.modules?.some(module => !module.id || !module.type || !Number.isFinite(Number(module.order)))) throw new Error('aPlus.modules 缺少 id、type 或 order。');
  tokens.aPlus = aPlus;
  return { document: doc, tokens, warnings, prose: String(md).slice(match[0].length) };
}

export function measurePixels(data, width, height) {
  const bins = new Map();
  const bucket = (r, g, b) => [r, g, b].map(n => Math.floor(n / 24)).join(',');
  const add = (map, key, values) => { const v = map.get(key) || { count: 0, sums: [0, 0, 0] }; v.count++; v.sums = v.sums.map((n, i) => n + values[i]); map.set(key, v); };
  const edges = new Map();
  let visible = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, alpha = data[offset + 3] / 255;
    const values = [0, 1, 2].map(k => data[offset + k] * alpha + 255 * (1 - alpha));
    const key = bucket(...values);
    add(bins, key, values); visible++;
    if (x < width * .035 || x > width * .965 || y < height * .035 || y > height * .965) add(edges, key, values);
  }
  const palette = [...bins.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(v => ({ color: toHex(v.sums.map(n => n / v.count)), share: Number((v.count / visible).toFixed(3)) }));
  const edge = [...edges.values()].sort((a, b) => b.count - a.count)[0];
  const background = edge ? toHex(edge.sums.map(n => n / edge.count)) : palette[0].color;
  const bg = rgb(background), grid = Array.from({ length: 6 }, () => Array(6).fill(0));
  let occupied = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, a = data[i + 3] / 255;
    const distance = Math.sqrt([0, 1, 2].reduce((n, k) => n + (data[i + k] * a + 255 * (1 - a) - bg[k]) ** 2, 0));
    if (distance > 48) { occupied++; sumX += x / width; sumY += y / height; grid[Math.min(5, Math.floor(y / height * 6))][Math.min(5, Math.floor(x / width * 6))]++; }
  }
  return { palette, background, occupancy: Number((occupied / visible).toFixed(3)), centroid: { x: occupied ? Number((sumX / occupied).toFixed(3)) : .5, y: occupied ? Number((sumY / occupied).toFixed(3)) : .5 }, grid: grid.map(row => row.map(n => Number((n / (visible / 36)).toFixed(2)))) };
}

export function buildAnalysisMd(references, projectName, mode = 'local', vision = null) {
  if (!references.length || references.some(r => !r.analysis)) throw new Error('参考图尚未完成真实像素分析。');
  references.forEach(r => { if (!r.evidence) r.evidence = extractLayoutEvidence(r); });
  const primary = references[0], a = primary.analysis;
  const palette = [...references.flatMap(r => r.analysis.palette)].sort((x, y) => y.share - x.share);
  const accent = palette.find(p => { const values = rgb(p.color); return Math.max(...values) - Math.min(...values) > 70 && contrast(a.background, p.color) > 2; })?.color || readable(a.background);
  const blocks = references.flatMap(r => r.ocr?.lines || []);
  const largeText = [...blocks].sort((a, b) => b.relativeHeight - a.relativeHeight)[0];
  const inferred = largeText && largeText.centerX < .4 ? 'left' : 'center';
  const v = vision || {};
  const system = buildDesignSystem(references, vision);
  const aPlus = buildAPlusSpec(references);
  const evidenceLayout = references[0].evidence?.layout || {};
  const visualLayout = vision?.layout || {};
  const document = {
    version: '1.1', name: projectName || '参考设计规范',
    source: { mode, references: references.map(r => ({ name: r.name, sha256: r.hash, width: r.width, height: r.height, background: r.analysis.background, palette: r.analysis.palette, occupancy: r.analysis.occupancy })) },
    description: v.description || `根据 ${references.length} 张参考图建立结构化视觉证据。像素、OCR 与版面候选均保留来源和置信度；语义、字体与品牌规则需人工确认。`,
    colors: { canvas: v.colors?.canvas || a.background, ink: v.colors?.ink || readable(a.background), primary: v.colors?.primary || accent },
    typography: {
      display: { fontFamily: v.typography?.display?.fontFamily || 'Inter', fontSize: clamp(Math.round((largeText?.relativeHeight || .074) * 1080), 48, 140) + 'px', fontWeight: v.typography?.display?.fontWeight || 600, lineHeight: 1.16, letterSpacing: '-0.5px', status: '推测，需确认；OCR 不能识别原始字体' },
      body: { fontFamily: v.typography?.body?.fontFamily || 'Inter', fontSize: '32px', fontWeight: 400, lineHeight: 1.47, status: '排版建议，需确认' },
    },
    layout: { mode: ['stack', 'split', 'image-top'].includes(visualLayout.mode) ? visualLayout.mode : 'stack', align: visualLayout.align === 'left' ? 'left' : (evidenceLayout.align || inferred), padding: Number(evidenceLayout.safeArea || .065), gap: Number(visualLayout.gap || .025), imageFraction: Number(visualLayout.imageFraction || evidenceLayout.imageFraction || .55), baseWidth: 1080, status: '版面候选来自结构化证据；请在证据面板确认' },
    aPlus,
    analysis: { method: mode === 'vision' ? 'multimodal+measurement+human-review' : 'measurement+ocr+human-review', confidence: mode === 'vision' ? '视觉模型为假设，必须确认' : '像素/OCR 证据，语义仍需确认', designSystem: system, evidence: references.map(r => r.evidence) },
    contentProtection: { originalImage: true, contain: true, rewriteCopy: false, recolor: false, crop: false },
  };
  let body = `## Overview\n\n${document.description}\n\n## Colors\n\n背景与色盘来自实际像素采样；色盘也可能含商品本身的颜色，请确认品牌色用途。\n\n`;
  body += references.map(r => `### ${r.name.replace(/[\r\n]/g, ' ')}\n\n- 尺寸：${r.width} × ${r.height}px\n- 背景估计（边缘采样）：${r.analysis.background}\n- 采样色盘：${r.analysis.palette.map(p => `${p.color} (${Math.round(p.share * 100)}%)`).join('、')}\n- 非背景内容占比：${Math.round(r.analysis.occupancy * 100)}%\n- 内容重心：x=${r.analysis.centroid.x}, y=${r.analysis.centroid.y}\n- SHA-256：${r.hash}\n`).join('\n');
  body += '\n## Typography\n\n字体不能仅凭像素或 OCR 可靠确定。参数区中的字体为可替换建议；中文缺字时使用本机中文字体，并在检查报告中记录实际字体。\n\n## Layout\n\nmode: stack（上文下图）、split（左右分栏）、image-top（上图下文）。padding、gap 是相对于画布宽度的比例；imageFraction 是产品图片区的目标占比。字号按 baseWidth 等比适配目标画布，空间不足时缩小至可读下限，仍不够则阻止导出。\n\n## Evidence Map\n\n每个参考画面保留文字框、产品候选框、来源和置信度。低置信度证据必须在界面中人工标注；证据不会直接复制参考图中的商品、Logo 或原文案。\n\n' + references.map(r => `### ${r.name.replace(/[\\r\\n]/g, ' ')}\n\n${(r.evidence?.elements || []).map(e => `- ${e.role}: (${e.bbox.x}, ${e.bbox.y}, ${e.bbox.width}, ${e.bbox.height}) · confidence ${e.bbox.confidence} · ${e.bbox.source}`).join('\\n') || '- 未检测到可确认的结构元素'}`).join('\\n\\n') + '\n\n## A+ Modules\n\n这是一套可复用的亚马逊 A+ 模块规范。STEP 3 应按 order 顺序匹配每个模块的图片槽位和文案槽位；替换内容时保留模块尺寸、槽位几何、图片比例和文案原文。\n\n' + aPlus.modules.map(module => `### ${module.order}. ${module.id} · ${module.type}\n\n- 区域：y=${module.y}，height=${module.height}\n- 证据置信度：${module.confidence}\n- 图片槽位：${module.template.imageSlots.length}\n- 文案槽位：${module.template.textSlots.length}\n- 复用：只替换图片与对应文案，保留模块几何\n`).join('\\n') + '\n## Components\n\n标题块、正文块、补充信息块、独立商品图层、背景色块。参考图中的商标、产品与文案不进入新设计。\n\n## OCR Evidence\n\n';
  body += references.map(r => `### ${r.name.replace(/[\r\n]/g, ' ')}\n\n${r.ocr ? `置信度 ${Math.round(r.ocr.confidence)}%；仅作参考，可能误识别。\n\n\`\`\`text\n${(r.ocr.text || '未检测到文字').replace(/```/g, '~~~')}\n\`\`\`` : '未启用 OCR；不推断图片中的确切文字。'}`).join('\n\n');
  if (vision) body += `\n\n## Visual Analysis\n\n${String(v.notes || v.description || '已完成视觉模型分析，详见参数区。')}\n`;
  body += '\n\n## A+ Module Geometry\n\n' + aPlus.modules.map(module => `### ${module.order}. ${module.type}\n\n- 模块框：x=${module.x ?? 0}，y=${module.y}，width=${module.width ?? 1}，height=${module.height}\n- 证据：${module.source}，置信度 ${module.confidence}${module.reason ? `；${module.reason}` : ''}\n- 图片槽位：${module.template.imageSlots.map(slot => `${slot.role} (${slot.bbox.x}, ${slot.bbox.y}, ${slot.bbox.width}, ${slot.bbox.height})`).join('；') || '未可靠识别'}\n- 文案槽位：${module.template.textSlots.map(slot => `${slot.role} (${slot.bbox.x}, ${slot.bbox.y}, ${slot.bbox.width}, ${slot.bbox.height})`).join('；') || '未可靠识别'}\n`).join('\n');
  body += '\n\n## A+ Module Evidence\n\n模块边界优先采用视觉模型针对每张参考图的检测结果；本地候选仅来自 OCR 间距，无法可靠分段时保留整图并标记待确认，不按比例虚构模块。模型返回的模块与槽位坐标均为相对比例，必须人工检查后再用于复用排版。\n';
  body += '\n\n## Do\n\n- 同一项目共用确认后的颜色、字体、间距。\n- 所有用户文案逐字保留，不增加价格、口号或宣传语。\n- 原图等比例完整显示，禁止拉伸、默认裁剪、换色及重绘。\n\n## Don\'t\n\n- 不复制参考图的商品、Logo 或文案。\n- 不把推测项当作测量事实。\n- 不用省略号或静默删字处理长文案。\n\n## Responsive Behavior\n\n按目标尺寸重新换行与计算几何，图片保持原比例。\n\n## Validation Checklist\n\n- [ ] 确认推测的字体与布局\n- [ ] 确认证据框的角色和置信度\n- [ ] 逐字核对新文案\n- [ ] 图片未裁切或拉伸\n- [ ] 画布无越界与非预期遮挡\n\n## Known Gaps\n\n图片分析是从栅格结果反推规则，不能保证恢复原始字体、原始图层或复杂交互。视觉模型、版面检测和分割结果都是候选证据，必须经过人工确认；生成排版使用原图作为独立图片层，不会把商品内部像素自动变成可编辑矢量。\n';
  return '---\n' + stringify(document, { lineWidth: 0 }) + '---\n\n' + body;
}

export function wrapText(text, maxWidth, measure) {
  const paragraphs = String(text).replace(/\r\n/g, '\n').split('\n');
  const result = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { result.push(''); continue; }
    let line = '';
    const units = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(paragraph)].map(s => s.segment) : Array.from(paragraph);
    for (const unit of units) {
      if (line && measure(line + unit) > maxWidth) { result.push(line); line = unit; } else line += unit;
    }
    result.push(line);
  }
  return result;
}

export function composeBoard({ asset, copy, tokens, width, height, measure, fonts, id, brandLogo = null }) {
  if (!asset || !asset.width || !asset.height) throw new Error('商品素材无效。');
  if (!copy.title || !copy.title.trim()) throw new Error('请填写标题；不会使用示例文字代替。');
  if (width < 320 || height < 320 || width > 4096 || height > 4096) throw new Error('画布尺寸必须为 320–4096px。');
  const scale = width / tokens.baseWidth, pad = Math.round(width * tokens.layout.padding), gap = Math.round(width * tokens.layout.gap);
  const innerW = width - pad * 2, innerH = height - pad * 2, split = tokens.layout.mode === 'split';
  const textW = split ? Math.floor(innerW * .47) : innerW;
  const targetH = split ? innerH : Math.floor(innerH * (1 - tokens.layout.imageFraction)) - gap;
  const fields = [{ key: 'title', value: copy.title, style: tokens.typography.title, font: fonts.title }, { key: 'body', value: copy.body || '', style: tokens.typography.body, font: fonts.body }, { key: 'detail', value: copy.detail || '', style: { ...tokens.typography.body, size: tokens.typography.body.size * .8 }, font: fonts.body }].filter(f => f.value !== '');
  let layouts, total, shrink = 1;
  for (let attempt = 0; attempt < 60; attempt++) {
    layouts = fields.map(field => {
      const size = Math.max(field.key === 'title' ? 22 * scale : 16 * scale, field.style.size * scale * shrink);
      const spacing = field.style.letterSpacing * scale;
      const lines = wrapText(field.value, textW, text => measure(text, { ...field.style, size, family: field.font, letterSpacing: spacing }));
      return { ...field, size, spacing, lines, lineHeight: field.style.lineHeight, height: lines.length * size * field.style.lineHeight };
    });
    total = layouts.reduce((n, l) => n + l.height, 0) + gap * Math.max(0, layouts.length - 1);
    if (total <= targetH) break;
    shrink *= .95;
    if (attempt === 59) throw new Error(`「${asset.name}」文案超过当前版式容量。请增大画布高度或调整规范；文案未被删减。`);
  }
  const nodes = [{ type: 'RECTANGLE', id: id + '-background', name: '背景', x: 0, y: 0, width, height, color: tokens.colors.background }];
  const logoWidth = brandLogo?.width ? Math.min(innerW * .22, 220 * scale) : 0;
  const logoHeight = brandLogo?.width ? brandLogo.height * (logoWidth / brandLogo.width) : 0;
  const logoReserve = brandLogo?.width ? logoHeight + gap : 0;
  let textY = pad + logoReserve;
  let imageBox;
  if (split) { imageBox = { x: pad + textW + gap, y: pad + logoReserve, width: innerW - textW - gap, height: innerH - logoReserve }; textY = Math.max(pad + logoReserve, pad + logoReserve + (innerH - logoReserve - total) / 2); }
  else {
    const imageH = innerH - total - gap - logoReserve;
    imageBox = { x: pad, y: tokens.layout.mode === 'image-top' ? pad + logoReserve : pad + logoReserve + total + gap, width: innerW, height: imageH };
    if (tokens.layout.mode === 'image-top') textY = pad + logoReserve + imageH + gap;
  }
  if (brandLogo?.width && brandLogo?.height) {
    nodes.push({ type: 'IMAGE', role: 'brand-logo', id: id + '-brand-logo', name: '品牌 Logo', assetId: brandLogo.id, hash: brandLogo.hash, x: Number((width - pad - logoWidth).toFixed(3)), y: Number((pad * .35).toFixed(3)), width: Number(logoWidth.toFixed(3)), height: Number(logoHeight.toFixed(3)), originalWidth: brandLogo.width, originalHeight: brandLogo.height, fit: 'contain' });
  }
  for (const layout of layouts) {
    nodes.push({ type: 'TEXT', id: id + '-' + layout.key, role: layout.key, name: { title: '标题', body: '正文', detail: '补充信息' }[layout.key], characters: layout.value, lines: layout.lines, x: pad, y: Math.round(textY), width: textW, height: Math.ceil(layout.height), fontSize: Number(layout.size.toFixed(3)), fontFamily: layout.font, requestedFont: layout.style.family, fontWeight: layout.style.weight, lineHeight: layout.lineHeight, letterSpacing: layout.spacing, align: tokens.layout.align, color: tokens.colors.foreground });
    textY += layout.height + gap;
  }
  const factor = Math.min(imageBox.width / asset.width, imageBox.height / asset.height);
  nodes.push({ type: 'IMAGE', id: id + '-product', name: asset.name, assetId: asset.id, hash: asset.hash, x: Number((imageBox.x + (imageBox.width - asset.width * factor) / 2).toFixed(3)), y: Number((imageBox.y + (imageBox.height - asset.height * factor) / 2).toFixed(3)), width: Number((asset.width * factor).toFixed(3)), height: Number((asset.height * factor).toFixed(3)), originalWidth: asset.width, originalHeight: asset.height, fit: 'contain' });
  const board = { id, name: copy.title, assetId: asset.id, width, height, nodes, copy: { ...copy }, tokens, warnings: [] };
  if (shrink < .99) board.warnings.push(`文案完整保留；字号缩至规范值的 ${Math.round(shrink * 100)}%。`);
  if (contrast(tokens.colors.background, tokens.colors.foreground) < 4.5) board.warnings.push('文字对比度低于 4.5:1。');
  if (asset.width < nodes.at(-1).width || asset.height < nodes.at(-1).height) board.warnings.push('商品原图分辨率低于输出展示尺寸，可能偏模糊。');
  return board;
}

export function validateBoard(board, asset) {
  const errors = [], warnings = [...board.warnings];
  for (const n of board.nodes) {
    if (![n.x, n.y, n.width, n.height].every(Number.isFinite) || n.x < -.1 || n.y < -.1 || n.x + n.width > board.width + .5 || n.y + n.height > board.height + .5) errors.push(`${n.name} 超出画布或坐标无效。`);
    if (n.type === 'TEXT' && n.characters !== board.copy[n.role]) errors.push(`${n.name} 与输入文案不一致。`);
    if (n.type === 'TEXT' && n.lines.join('') !== n.characters.replace(/\r?\n/g, '')) errors.push(`${n.name} 换行时丢失内容。`);
    if (n.type === 'IMAGE' && n.role !== 'brand-logo' && (n.hash !== asset.hash || n.assetId !== asset.id || Math.abs(n.width / n.height - asset.width / asset.height) > .001)) errors.push('商品素材或比例发生变化。');
  }
  for (const [i, a] of board.nodes.entries()) for (const b of board.nodes.slice(i + 1)) {
    if (a.type === 'RECTANGLE' || b.type === 'RECTANGLE') continue;
    if (a.role === 'brand-logo' || b.role === 'brand-logo') continue;
    const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
    if (overlap) errors.push(`${a.name} 与 ${b.name} 出现非预期重叠。`);
  }
  return { ok: errors.length === 0, boardId: board.id, errors, warnings, checks: ['素材 SHA-256 引用一致', '原图等比例完整显示', '文案逐字一致', '图层未越界', '图层未重叠'] };
}

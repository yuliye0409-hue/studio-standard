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

/** Only model-provided module geometry is reusable; never derive slots from OCR. */
export function extractAPlusModules(reference) {
  const modelModules = modelAPlusModules(reference || {});
  const modules = modelModules || [{ id: 'module-1', order: 1, type: 'unclassified', x: 0, y: 0, width: 1, height: 1, confidence: .15, source: 'unsegmented-image', reason: '视觉模型未提供可靠模块，整图保留为待确认区域；不推测分区或补造槽位。', template: { type: 'unclassified', imageSlots: [], textSlots: [], spacing: { padding: .04, gap: .025 }, background: 'inherit', reuse: { replaceImagesOnly: true, preserveSlotGeometry: true, preserveCopyExactly: true } } }];
  return { version: 'a-plus-layout/1', type: 'long-form-amazon-a-plus', source: reference.hash, canvas: { width: reference.width, height: reference.height }, moduleCount: modules.length, reviewRequired: modules.some(module => module.confidence < .6), modules, rules: { preserveOrder: true, preserveImageRatio: true, containByDefault: true, allowCrop: false, allowStretch: false, rewriteCopy: false, requireReviewBeforeExport: true } };
}

export function buildAPlusSpec(references) {
  const modules = references.flatMap((reference, index) => {
    const spec = extractAPlusModules(reference);
    return spec.modules.map(module => ({ ...module, sourceReference: reference.name, sourceReferenceIndex: index, sourceCanvas: { width: reference.width, height: reference.height } }));
  });
  return { version: 'a-plus-system/1', type: 'long-form-amazon-a-plus', referenceCount: references.length, modules, reviewRequired: modules.some(module => module.confidence < .6), export: { preserveOrder: true, requireReviewBeforeExport: true, formats: ['png', 'jpg', 'project-json', 'figma-json'] } };
}

/** Keep structural evidence from the vision model, never legacy OCR or pixel semantics. */
export function extractLayoutEvidence(reference) {
  if (!reference?.analysis) throw new Error('必须先完成像素测量才能记录参考图。');
  const elements = (reference.evidence?.elements || []).filter(item => {
    const b = item.bbox;
    return b?.source === 'vision' && roleNames.has(item.role) && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x + b.width <= 1.001 && b.y + b.height <= 1.001;
  }).map((item, index) => ({ id: item.id || `vision-${index + 1}`, role: item.role, text: '', bbox: { ...box(item.bbox.x, item.bbox.y, item.bbox.width, item.bbox.height, item.bbox.confidence, 'vision'), reason: String(item.bbox.reason || '') } }));
  return { version: 'layout-evidence/2', source: reference.hash, elements, manualReview: elements.length === 0 || elements.some(e => e.bbox.confidence < .6) };
}

export function buildDesignSystem(references, vision = null) {
  const evidence = references.map(reference => ({ name: reference.name, hash: reference.hash, dimensions: { width: reference.width, height: reference.height }, analysis: reference.analysis, evidence: extractLayoutEvidence(reference) }));
  return { version: 'design-system/2', method: vision ? 'multimodal+measurement+human-review' : 'measurement-only', confidence: vision ? 'model output is a hypothesis; confirm all tokens' : 'pixel measurements only; layout analysis unavailable', references: evidence, vision: vision || null };
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
  const legacySource = value => {
    if (!value || typeof value !== 'object') return false;
    if (['ocr', 'ocr-gap-candidate', 'pixel-occupancy'].includes(value.source)) return true;
    return Object.values(value).some(item => Array.isArray(item) ? item.some(legacySource) : legacySource(item));
  };
  const requiresReanalysis = ['local', 'pixels'].includes(doc.source?.mode) || /ocr/i.test(String(doc.analysis?.method || doc.analysis?.designSystem?.method || '')) || legacySource(doc.analysis?.evidence) || legacySource(doc.analysis?.designSystem?.references) || legacySource(doc.aPlus || doc.aplus);
  const warnings = requiresReanalysis ? ['此规范包含旧本地分析或文字识别结果，可能影响布局。请使用视觉模型重新分析参考图；旧规范暂不可用于新排版。'] : [];
  if (contrast(background, foreground) < 4.5) warnings.push('正文与背景对比度低于 4.5:1，请确认是否调整文字色。');
  const aPlus = doc.aPlus || doc.aplus || null;
  if (aPlus?.modules && !Array.isArray(aPlus.modules)) throw new Error('aPlus.modules 必须是数组。');
  if (aPlus?.modules?.some(module => !module.id || !module.type || !Number.isFinite(Number(module.order)))) throw new Error('aPlus.modules 缺少 id、type 或 order。');
  tokens.aPlus = aPlus ? { ...aPlus, modules: (aPlus.modules || []).map(module => ({ ...module, sourceCanvas: module.sourceCanvas || doc.source?.references?.[module.sourceReferenceIndex ?? 0] })) } : null;
  return { document: doc, tokens, warnings, requiresReanalysis, prose: String(md).slice(match[0].length) };
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

export function buildAnalysisMd(references, projectName, mode = 'measurement', vision = null) {
  if (!references.length || references.some(r => !r.analysis)) throw new Error('参考图尚未完成真实像素分析。');
  if (mode === 'vision' && !vision) throw new Error('缺少视觉模型分析结果，不能生成模型规范。');
  references.forEach(r => { r.evidence = extractLayoutEvidence(r); });
  const primary = references[0], a = primary.analysis;
  const palette = [...references.flatMap(r => r.analysis.palette)].sort((x, y) => y.share - x.share);
  const accent = palette.find(p => { const values = rgb(p.color); return Math.max(...values) - Math.min(...values) > 70 && contrast(a.background, p.color) > 2; })?.color || readable(a.background);
  const v = vision || {};
  const system = buildDesignSystem(references, vision);
  const aPlus = buildAPlusSpec(references);
  const visualLayout = vision?.layout || {};
  const document = {
    version: '1.1', name: projectName || '参考设计规范',
    source: { mode, references: references.map(r => ({ name: r.name, sha256: r.hash, width: r.width, height: r.height, background: r.analysis.background, palette: r.analysis.palette, occupancy: r.analysis.occupancy })) },
    description: v.description || `根据 ${references.length} 张参考图记录像素测量。未调用视觉模型时不推断布局；字体与品牌规则需人工确认。`,
    colors: { canvas: v.colors?.canvas || a.background, ink: v.colors?.ink || readable(a.background), primary: v.colors?.primary || accent },
    typography: {
      display: { fontFamily: v.typography?.display?.fontFamily || 'Inter', fontSize: clamp(number(v.typography?.display?.fontSize, 80), 10, 300) + 'px', fontWeight: v.typography?.display?.fontWeight || 600, lineHeight: clamp(number(v.typography?.display?.lineHeight, 1.16), 1, 2), letterSpacing: number(v.typography?.display?.letterSpacing, -.5) + 'px', status: '模型推测或排版建议，需确认；不能仅凭图片保证原始字体' },
      body: { fontFamily: v.typography?.body?.fontFamily || 'Inter', fontSize: clamp(number(v.typography?.body?.fontSize, 32), 8, 160) + 'px', fontWeight: v.typography?.body?.fontWeight || 400, lineHeight: clamp(number(v.typography?.body?.lineHeight, 1.47), 1, 2.5), status: '排版建议，需确认' },
    },
    layout: { mode: ['stack', 'split', 'image-top'].includes(visualLayout.mode) ? visualLayout.mode : 'stack', align: visualLayout.align === 'left' ? 'left' : 'center', padding: clamp(number(visualLayout.padding, .065), .025, .18), gap: Number(visualLayout.gap || .025), imageFraction: Number(visualLayout.imageFraction || .55), baseWidth: 1080, status: '版面候选来自结构化证据；请在证据面板确认' },
    aPlus,
    analysis: { method: vision ? 'multimodal+measurement+human-review' : 'measurement-only', confidence: vision ? '视觉模型为假设，必须确认' : '仅像素测量，不代表布局分析', designSystem: system, evidence: references.map(r => r.evidence) },
    contentProtection: { originalImage: true, contain: true, rewriteCopy: false, recolor: false, crop: false },
  };
  let body = `## Overview\n\n${document.description}\n\n## Colors\n\n背景与色盘来自实际像素采样；色盘也可能含商品本身的颜色，请确认品牌色用途。\n\n`;
  body += references.map(r => `### ${r.name.replace(/[\r\n]/g, ' ')}\n\n- 尺寸：${r.width} × ${r.height}px\n- 背景估计（边缘采样）：${r.analysis.background}\n- 采样色盘：${r.analysis.palette.map(p => `${p.color} (${Math.round(p.share * 100)}%)`).join('、')}\n- 非背景内容占比：${Math.round(r.analysis.occupancy * 100)}%\n- 内容重心：x=${r.analysis.centroid.x}, y=${r.analysis.centroid.y}\n- SHA-256：${r.hash}\n`).join('\n');
  body += '\n## Typography\n\n字体不能仅凭栅格图片可靠确定。参数区中的字体为可替换建议；中文缺字时使用本机中文字体，并在检查报告中记录实际字体。\n\n## Layout\n\n优先执行已确认模块的图片与文字槽位；没有可靠槽位时才明确使用通用版式。通用 mode: stack（上文下图）、split（左右分栏）、image-top（上图下文）。padding、gap 是相对于画布宽度的比例；imageFraction 是产品图片区的目标占比。字号按 baseWidth 等比适配目标画布，空间不足时缩小至可读下限，仍不够则阻止导出。\n\n## Evidence Map\n\n每个参考画面保留文字框、产品候选框、来源和置信度。低置信度证据必须人工复核；证据不会直接复制参考图中的商品、Logo 或原文案。\n\n' + references.map(r => `### ${r.name.replace(/[\\r\\n]/g, ' ')}\n\n${(r.evidence?.elements || []).map(e => `- ${e.role}: (${e.bbox.x}, ${e.bbox.y}, ${e.bbox.width}, ${e.bbox.height}) · confidence ${e.bbox.confidence} · ${e.bbox.source}`).join('\\n') || '- 未检测到可确认的结构元素'}`).join('\\n\\n') + '\n\n## A+ Modules\n\n这是一套可复用的亚马逊 A+ 模块规范。STEP 3 按新图片的实际宽高比与文案容量匹配可靠模块，也可逐图手动指定；作品保持用户的图文顺序。替换内容时保留相对槽位几何、原图比例和文案原文。未可靠识别槽位时明确标记为通用版式，不宣称完成参考排版复用。\n\n' + aPlus.modules.map(module => `### ${module.order}. ${module.id} · ${module.type}\n\n- 区域：y=${module.y}，height=${module.height}\n- 证据置信度：${module.confidence}\n- 图片槽位：${module.template.imageSlots.length}\n- 文案槽位：${module.template.textSlots.length}\n- 复用：只替换图片与对应文案，保留模块几何\n`).join('\\n') + '\n## Components\n\n标题块、正文块、补充信息块、独立商品图层、背景色块。参考图中的商标、产品与文案不进入新设计。\n';
  if (vision) body += `\n\n## Visual Analysis\n\n${String(v.notes || v.description || '已完成视觉模型分析，详见参数区。')}\n`;
  body += '\n\n## A+ Module Geometry\n\n' + aPlus.modules.map(module => `### ${module.order}. ${module.type}\n\n- 模块框：x=${module.x ?? 0}，y=${module.y}，width=${module.width ?? 1}，height=${module.height}\n- 证据：${module.source}，置信度 ${module.confidence}${module.reason ? `；${module.reason}` : ''}\n- 图片槽位：${module.template.imageSlots.map(slot => `${slot.role} (${slot.bbox.x}, ${slot.bbox.y}, ${slot.bbox.width}, ${slot.bbox.height})`).join('；') || '未可靠识别'}\n- 文案槽位：${module.template.textSlots.map(slot => `${slot.role} (${slot.bbox.x}, ${slot.bbox.y}, ${slot.bbox.width}, ${slot.bbox.height})`).join('；') || '未可靠识别'}\n`).join('\n');
  body += '\n\n## A+ Module Evidence\n\n模块边界仅采用视觉模型针对每张参考图的检测结果；无法可靠分段时保留整图并标记待确认，不从文字识别结果推断或按比例虚构模块。模型返回的模块与槽位坐标均为相对比例，必须人工检查后再用于复用排版。\n';
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

const slotBox = value => {
  const b = Array.isArray(value) ? { x: value[0], y: value[1], width: value[2], height: value[3] } : value;
  if (!b || ![b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n)) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > 1.00001 || b.y + b.height > 1.00001) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
};
const textRole = role => ['headline', 'title', 'heading'].includes(role) ? 'title' : ['body', 'subtitle', 'description'].includes(role) ? 'body' : ['price', 'detail', 'caption', 'specification'].includes(role) ? 'detail' : null;
const moduleNames = { hero: '首屏主视觉', 'image-text-split': '左右图文', 'feature-grid': '卖点网格', 'feature-panel': '卖点展示', 'detail-panel': '细节展示', 'shortcut-comparison': '功能对照', 'closing-panel': '品牌收尾', unclassified: '待确认模块' };
const intersects = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > .00001 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > .00001;

export function layoutModules(tokens) {
  return (tokens.aPlus?.modules || []).map((module, index) => {
    const images = module.template?.imageSlots || [], texts = module.template?.textSlots || [];
    let reason = '';
    if (!Array.isArray(images) || !Array.isArray(texts)) reason = '图片与文字槽位必须是列表';
    else if (images.length !== 1) reason = images.length ? '含多个图片槽位，当前一图一卡无法完整填充' : '没有可靠的图片槽位';
    else if (!slotBox(images[0]?.bbox) || texts.some(s => !slotBox(s?.bbox))) reason = '槽位坐标无效';
    return { key: `${index}:${module.id}`, module, reason, label: `${index + 1}. ${moduleNames[module.type] || module.type} · ${module.sourceReference || module.id}` };
  });
}

function composeModuleBoard(options, choice) {
  const { asset, copy, tokens, width, height, measure, fonts, id, brandLogo } = options, { module } = choice;
  if (choice.reason) throw new Error(choice.reason);
  const scale = width / tokens.baseWidth, warnings = [], slot = module.template.imageSlots[0], b = slotBox(slot.bbox);
  const imageBox = { x: b.x * width, y: b.y * height, width: b.width * width, height: b.height * height };
  const factor = Math.min(imageBox.width / asset.width, imageBox.height / asset.height);
  const image = { type: 'IMAGE', id: id + '-product', name: asset.name, assetId: asset.id, hash: asset.hash, slotId: slot.id || 'image-1', slotBox: b, x: imageBox.x + (imageBox.width - asset.width * factor) / 2, y: imageBox.y + (imageBox.height - asset.height * factor) / 2, width: asset.width * factor, height: asset.height * factor, originalWidth: asset.width, originalHeight: asset.height, fit: 'contain' };
  const nodes = [{ type: 'RECTANGLE', id: id + '-background', name: '背景', x: 0, y: 0, width, height, color: tokens.colors.background }, image];
  let smallestShrink = 1;
  for (const field of ['title', 'body', 'detail']) {
    const value = String(copy[field] || ''), slots = module.template.textSlots.filter(s => textRole(s.role) === field);
    // Reference modules describe visual guidance, not copy requirements. Empty
    // user fields stay empty even when a source slot was marked required.
    if (!value) continue;
    if (!slots.length) throw new Error(`缺少${{ title: '标题', body: '正文', detail: '补充信息' }[field]}槽位，不能丢弃该段文案`);
    const textSlot = [...slots].sort((a, b) => slotBox(b.bbox).width * slotBox(b.bbox).height - slotBox(a.bbox).width * slotBox(a.bbox).height)[0];
    const rect = slotBox(textSlot.bbox), textW = rect.width * width, textH = rect.height * height;
    const style = field === 'title' ? tokens.typography.title : { ...tokens.typography.body, size: tokens.typography.body.size * (field === 'detail' ? .8 : 1) };
    const family = field === 'title' ? fonts.title : fonts.body, spacing = style.letterSpacing * scale;
    let shrink = 1, size, lines, usedHeight, fit = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      size = Math.max((field === 'title' ? 22 : 16) * scale, style.size * scale * shrink);
      const textMeasure = text => measure(text, { ...style, size, family, letterSpacing: spacing });
      lines = wrapText(value, textW, textMeasure); usedHeight = lines.length * size * style.lineHeight;
      if (usedHeight <= textH && lines.every(line => textMeasure(line) <= textW + .1)) { fit = true; break; }
      shrink *= .95;
    }
    if (!fit) throw new Error(`${{ title: '标题', body: '正文', detail: '补充信息' }[field]}槽位 ${Math.round(textW)}×${Math.round(textH)}px 容量不足（需要约 ${Math.ceil(usedHeight)}px 高）；请选择其他模块或调整槽位。文案未被删减。`);
    smallestShrink = Math.min(smallestShrink, size / (style.size * scale));
    nodes.push({ type: 'TEXT', id: id + '-' + field, role: field, name: { title: '标题', body: '正文', detail: '补充信息' }[field], slotId: textSlot.id || field, slotBox: rect, characters: value, lines, x: rect.x * width, y: rect.y * height, width: textW, height: usedHeight, fontSize: size, fontFamily: family, requestedFont: style.family, fontWeight: style.weight, lineHeight: style.lineHeight, letterSpacing: spacing, align: tokens.layout.align, color: tokens.colors.foreground });
  }
  if (brandLogo?.width && brandLogo?.height) {
    const logoWidth = Math.min(width * .18, 220 * scale, height * .12 * brandLogo.width / brandLogo.height);
    let placement;
    for (const shrink of [1, .85, .7, .55, .4]) {
      const w = logoWidth * shrink, h = w * brandLogo.height / brandLogo.width;
      for (const [x, y] of [[width * .98 - w, height * .02], [width * .02, height * .02], [width * .98 - w, height * .98 - h], [width * .02, height * .98 - h]]) {
        const rect = { x, y, width: w, height: h };
        if (!nodes.some(n => n.type !== 'RECTANGLE' && intersects(rect, n))) { placement = rect; break; }
      }
      if (placement) break;
    }
    if (!placement) throw new Error('品牌 Logo 没有不遮挡图文的可用位置，请在规范中预留 Logo 留白');
    nodes.push({ type: 'IMAGE', role: 'brand-logo', id: id + '-brand-logo', name: '品牌 Logo', assetId: brandLogo.id, hash: brandLogo.hash, ...placement, originalWidth: brandLogo.width, originalHeight: brandLogo.height, fit: 'contain' });
  }
  if (smallestShrink < .99) warnings.push(`文案完整保留；为适配模块槽位，字号缩至规范值的 ${Math.round(smallestShrink * 100)}%。`);
  if (!(module.confidence >= .6)) warnings.push('手动选用低置信度或未知置信度模块，请核对参考布局。');
  if (nodes.some(n => n.type === 'TEXT' && intersects(n.slotBox, b))) warnings.push('参考槽位包含图文叠层，请人工检查文字在照片上的可读性。');
  if (contrast(tokens.colors.background, tokens.colors.foreground) < 4.5) warnings.push('文字与背景色对比度低于 4.5:1。');
  if (asset.width < image.width || asset.height < image.height) warnings.push('商品原图分辨率低于输出展示尺寸，可能偏模糊。');
  const board = { id, name: String(copy.title || '').trim() || asset.name.replace(/\.[^.]+$/, '') || '作品', assetId: asset.id, width, height, nodes, copy: { ...copy }, tokens, warnings, layoutMatch: { kind: 'module', key: choice.key, moduleId: module.id, label: choice.label, imageFit: Math.min((asset.width / asset.height) / (imageBox.width / imageBox.height), (imageBox.width / imageBox.height) / (asset.width / asset.height)), shrink: smallestShrink } };
  const report = validateBoard(board, asset); if (!report.ok) throw new Error(report.errors.join(' '));
  return board;
}

export function composeBoard(options) {
  const { asset, copy, width, height, tokens, moduleKey = 'auto', assetIndex = 0 } = options;
  if (!asset || !asset.width || !asset.height) throw new Error('商品素材无效。');
  if (![width, height].every(n => Number.isInteger(n) && n >= 320 && n <= 4096)) throw new Error('画布尺寸必须为 320–4096px 的整数。');
  const choices = layoutModules(tokens);
  if (moduleKey !== 'auto' && moduleKey !== 'generic') {
    const choice = choices.find(c => c.key === moduleKey);
    if (!choice) throw new Error(`「${asset.name}」原模块已不存在，请重新选择版式。`);
    try { return composeModuleBoard(options, choice); } catch (error) { throw new Error(`「${asset.name}」模块 ${choice.label}：${error.message}`); }
  }
  const failures = [], candidates = [];
  if (moduleKey === 'auto') for (const [index, choice] of choices.entries()) {
    if (choice.reason || !(choice.module.confidence >= .6)) { failures.push(choice.reason || '模块置信度不足'); continue; }
    try {
      const board = composeModuleBoard(options, choice), m = choice.module, source = m.sourceCanvas;
      const moduleRatio = source?.width > 0 && source?.height > 0 ? source.width * (m.width || 1) / (source.height * (m.height || 1)) : width / height;
      const canvasFit = Math.min(moduleRatio / (width / height), (width / height) / moduleRatio);
      candidates.push({ board, score: board.layoutMatch.imageFit * .75 + canvasFit * .2 + board.layoutMatch.shrink * .05, tie: Math.abs(index - assetIndex % Math.max(1, choices.length)) });
    } catch (error) { failures.push(`${choice.label}：${error.message}`); }
  }
  candidates.sort((a, b) => b.score - a.score || a.tie - b.tie);
  if (candidates.length) return candidates[0].board;
  if (moduleKey === 'auto' && choices.some(c => !c.reason && c.module.confidence >= .6)) throw new Error(`「${asset.name}」没有可容纳当前图文的参考模块：${failures.join('；')}。可在该图片的版式选择中检查其他模块；不会静默改用通用布局或删减文案。`);
  try {
    const board = composeGenericBoard(options);
    board.layoutMatch = { kind: 'generic', label: `通用版式 · ${{ stack: '上文下图', split: '左右分栏', 'image-top': '上图下文' }[tokens.layout.mode]}`, reason: moduleKey === 'generic' ? '手动选择通用版式' : failures[0] || 'MD 没有可执行的模块槽位' };
    if (choices.length && moduleKey === 'auto') board.warnings.push(`未匹配可靠模块，使用通用版式：${board.layoutMatch.reason}。`);
    return board;
  } catch (error) { throw new Error(error.message + (failures.length ? ` 模块匹配：${failures[0]}` : '')); }
}

function composeGenericBoard({ asset, copy, tokens, width, height, measure, fonts, id, brandLogo = null }) {
  if (!asset || !asset.width || !asset.height) throw new Error('商品素材无效。');
  if (width < 320 || height < 320 || width > 4096 || height > 4096) throw new Error('画布尺寸必须为 320–4096px。');
  const scale = width / tokens.baseWidth, requestedPad = Math.round(width * tokens.layout.padding), pad = Math.min(requestedPad, Math.round(height * .12)), gap = Math.min(Math.round(width * tokens.layout.gap), Math.round(height * .04));
  const innerW = width - pad * 2, innerH = height - pad * 2, split = tokens.layout.mode === 'split';
  const logoWidth = brandLogo?.width ? Math.min(innerW * .22, 220 * scale, innerH * .15 * brandLogo.width / brandLogo.height) : 0;
  const logoHeight = brandLogo?.width ? brandLogo.height * (logoWidth / brandLogo.width) : 0;
  const logoReserve = brandLogo?.width ? logoHeight + gap : 0;
  const textW = split ? Math.floor(innerW * .47) : innerW;
  let targetH = split ? innerH - logoReserve : Math.floor((innerH - logoReserve) * (1 - tokens.layout.imageFraction)) - gap;
  const originalTargetH = targetH, availableH = innerH - logoReserve;
  const expandedTargetH = availableH - Math.min(innerW * asset.height / asset.width, availableH * .3) - gap;
  const fields = [{ key: 'title', value: copy.title, style: tokens.typography.title, font: fonts.title }, { key: 'body', value: copy.body || '', style: tokens.typography.body, font: fonts.body }, { key: 'detail', value: copy.detail || '', style: { ...tokens.typography.body, size: tokens.typography.body.size * .8 }, font: fonts.body }].filter(f => f.value !== '');
  let layouts, total, shrink = 1;
  for (let attempt = 0; attempt < 60; attempt++) {
    layouts = fields.map(field => {
      const size = Math.max(field.key === 'title' ? 22 * scale : 16 * scale, field.style.size * scale * shrink);
      const spacing = field.style.letterSpacing * scale;
      const textMeasure = text => measure(text, { ...field.style, size, family: field.font, letterSpacing: spacing });
      const lines = wrapText(field.value, textW, textMeasure);
      return { ...field, size, spacing, lines, fitsWidth: lines.every(line => textMeasure(line) <= textW + .1), lineHeight: field.style.lineHeight, height: lines.length * size * field.style.lineHeight };
    });
    total = layouts.reduce((n, l) => n + l.height, 0) + gap * Math.max(0, layouts.length - 1);
    if (total <= targetH && layouts.every(l => l.fitsWidth)) break;
    shrink *= .95;
    if (attempt === 59 && !split && expandedTargetH > targetH + 1) { targetH = expandedTargetH; shrink = 1; attempt = -1; continue; }
    if (attempt === 59) throw new Error(`「${asset.name}」${width}×${height}px 通用版式的文字区高 ${Math.max(0, targetH)}px，需要约 ${Math.ceil(total)}px。请选择其他模块或调整画布/规范；文案未被删减。`);
  }
  const nodes = [{ type: 'RECTANGLE', id: id + '-background', name: '背景', x: 0, y: 0, width, height, color: tokens.colors.background }];
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
  const board = { id, name: String(copy.title || '').trim() || asset.name.replace(/\.[^.]+$/, '') || '作品', assetId: asset.id, width, height, nodes, copy: { ...copy }, tokens, warnings: [] };
  if (pad < requestedPad) board.warnings.push(`横幅留白已适配实际画布高度：${requestedPad}px → ${pad}px；未改变输出尺寸或原图。`);
  if (targetH > originalTargetH) board.warnings.push('为完整保留文案，通用版式已重新分配图文空间；原图仍等比例完整显示，请检查展示大小。');
  shrink = Math.min(1, ...layouts.map(l => l.size / (l.style.size * scale)));
  if (shrink < .99) board.warnings.push(`文案完整保留；字号缩至规范值的 ${Math.round(shrink * 100)}%。`);
  if (contrast(tokens.colors.background, tokens.colors.foreground) < 4.5) board.warnings.push('文字对比度低于 4.5:1。');
  if (asset.width < nodes.at(-1).width || asset.height < nodes.at(-1).height) board.warnings.push('商品原图分辨率低于输出展示尺寸，可能偏模糊。');
  return board;
}

export function validateBoard(board, asset) {
  const errors = [], warnings = [...board.warnings];
  const module = board.layoutMatch?.kind === 'module' ? layoutModules(board.tokens).find(c => c.key === board.layoutMatch.key)?.module : null;
  const sourceSlot = node => {
    if (!module || !node.slotBox) return null;
    const slots = node.type === 'IMAGE' ? module.template.imageSlots : module.template.textSlots;
    return slots.find(s => (node.type === 'IMAGE' || textRole(s.role) === node.role) && slotBox(s.bbox) && ['x', 'y', 'width', 'height'].every(key => Math.abs(slotBox(s.bbox)[key] - node.slotBox[key]) < .00001));
  };
  if (board.layoutMatch?.kind === 'module' && !module) errors.push('匹配的模块已不存在。');
  for (const n of board.nodes) {
    if (![n.x, n.y, n.width, n.height].every(Number.isFinite) || n.x < -.1 || n.y < -.1 || n.x + n.width > board.width + .5 || n.y + n.height > board.height + .5) errors.push(`${n.name} 超出画布或坐标无效。`);
    if (n.type === 'TEXT' && n.characters !== board.copy[n.role]) errors.push(`${n.name} 与输入文案不一致。`);
    if (n.type === 'TEXT' && n.lines.join('') !== n.characters.replace(/\r?\n/g, '')) errors.push(`${n.name} 换行时丢失内容。`);
    if (n.type === 'IMAGE' && n.role !== 'brand-logo' && (n.hash !== asset.hash || n.assetId !== asset.id || Math.abs(n.width / n.height - asset.width / asset.height) > .001)) errors.push('商品素材或比例发生变化。');
    if (module && n.type !== 'RECTANGLE' && n.role !== 'brand-logo') {
      const slot = sourceSlot(n), b = slot && slotBox(slot.bbox);
      if (!b || n.x < b.x * board.width - .1 || n.y < b.y * board.height - .1 || n.x + n.width > (b.x + b.width) * board.width + .1 || n.y + n.height > (b.y + b.height) * board.height + .1) errors.push(`${n.name} 不在 MD 指定槽位内。`);
    }
  }
  for (const [i, a] of board.nodes.entries()) for (const b of board.nodes.slice(i + 1)) {
    if (a.type === 'RECTANGLE' || b.type === 'RECTANGLE') continue;
    const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
    const templateOverlay = a.type !== b.type && sourceSlot(a) && sourceSlot(b) && intersects(a.slotBox, b.slotBox);
    if (overlap && !templateOverlay) errors.push(`${a.name} 与 ${b.name} 出现非预期重叠。`);
  }
  return { ok: errors.length === 0, boardId: board.id, errors, warnings, checks: ['素材 SHA-256 引用一致', '原图等比例完整显示', '文案逐字一致', '图层未越界', '无非预期重叠'] };
}

import { measurePixels, uid } from './core.js';

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法解码图片，请使用 PNG、JPG 或 WebP。')); image.src = dataUrl; });
}
export const readDataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
export async function sha256(dataUrl) {
  const bytes = await (await fetch(dataUrl)).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function makeAsset(dataUrl, name, extra = {}) {
  const image = await loadImage(dataUrl);
  if (image.width * image.height > 80_000_000) throw new Error('图片超过 8000 万像素，请缩小后重试。');
  return { id: uid(), name, dataUrl, hash: await sha256(dataUrl), width: image.width, height: image.height, ...extra };
}
export async function analyzeAsset(asset) {
  const image = await loadImage(asset.dataUrl), canvas = document.createElement('canvas');
  const factor = Math.min(1, 240 / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * factor)); canvas.height = Math.max(1, Math.round(image.height * factor));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { ...asset, analysis: measurePixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height) };
}
/** Overview preserves context; overlapping detail crops preserve long-image legibility. */
export async function prepareVisionReference(reference) {
  const image = await loadImage(reference.dataUrl), width = image.width, height = image.height;
  const render = (x, y, w, h, limit) => {
    const factor = Math.min(1, limit / Math.max(w, h)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * factor)); canvas.height = Math.max(1, Math.round(h * factor));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  };
  const overview = render(0, 0, width, height, 2400), tiles = [];
  const vertical = height >= width, major = Math.max(width, height), minor = Math.min(width, height);
  if (major / minor > 2.2) {
    const span = Math.min(major, Math.ceil(Math.max(minor * 1.2, major / (1 + 7 * .88))));
    const count = Math.min(8, Math.ceil((major - span) / (span * .88)) + 1);
    for (let i = 0; i < count; i++) {
      const offset = Math.round(i * (major - span) / Math.max(1, count - 1));
      const x = vertical ? 0 : offset, y = vertical ? offset : 0, w = vertical ? width : span, h = vertical ? span : height;
      tiles.push({ bbox: [x / width, y / height, w / width, h / height], dataUrl: render(x, y, w, h, 1600) });
    }
  }
  return { overview, tiles };
}

export async function readFiles(files, role, progress) {
  const result = [];
  for (const file of files) {
    if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name} 超过 30MB。`);
    progress?.(`正在读取 ${file.name}`);
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (role !== 'reference') throw new Error('商品素材请使用 PNG/JPG/WebP；PDF 仅用作参考设计。');
      const pdfjs = await import('/vendor/pdfjs-dist/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.mjs';
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer(), cMapUrl: '/vendor/pdfjs-dist/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs-dist/standard_fonts/', wasmUrl: '/vendor/pdfjs-dist/wasm/' }).promise;
      if (pdf.numPages > 20) { await pdf.destroy(); throw new Error('PDF 超过 20 页，请拆分后上传；不会静默省略页面。'); }
      try { for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
        progress?.(`渲染 ${file.name}：${pageIndex}/${pdf.numPages} 页`);
        const page = await pdf.getPage(pageIndex), base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) });
        const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        result.push(await makeAsset(canvas.toDataURL('image/png'), `${file.name} · 第 ${pageIndex} 页`, { source: { type: 'pdf', file: file.name, page: pageIndex } }));
        page.cleanup();
      } } finally { await pdf.destroy(); }
    } else {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(`${file.name}：支持 PNG、JPG、WebP 和参考 PDF。`);
      result.push(await makeAsset(await readDataUrl(file), file.name));
    }
  }
  return result;
}

function fontAvailable(family) {
  const ctx = document.createElement('canvas').getContext('2d');
  const text = 'mmmmmmmmmmlli000设计规范';
  ctx.font = '72px monospace'; const base = ctx.measureText(text).width;
  ctx.font = `72px "${family}", monospace`;
  return Math.abs(ctx.measureText(text).width - base) > .1;
}
export async function resolveFonts(tokens, text) {
  await document.fonts.ready;
  const hasCjk = /[\u2e80-\u9fff]/.test(text);
  const resolve = requested => {
    const candidates = requested.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(s => !['system-ui', '-apple-system', 'sans-serif', 'BlinkMacSystemFont'].includes(s));
    // Pick an explicit CJK font for mixed-language copy rather than relying on
    // the browser's invisible per-glyph fallback, which Figma cannot reproduce.
    if (hasCjk && !candidates.some(f => /YaHei|PingFang|Noto Sans.*(SC|CJK)|SimHei|SimSun/i.test(f))) candidates.unshift('Microsoft YaHei', 'Noto Sans CJK SC', 'PingFang SC');
    candidates.push('Inter', 'Arial');
    const chosen = candidates.find(fontAvailable) || 'Arial';
    return chosen;
  };
  return { title: resolve(tokens.typography.title.family), body: resolve(tokens.typography.body.family) };
}

export function textMeasurer() {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text, style) => {
    ctx.font = `${style.weight} ${style.size}px "${style.family}"`;
    ctx.letterSpacing = `${style.letterSpacing || 0}px`;
    return ctx.measureText(text).width;
  };
}

export async function renderBoard(board, assets, format = 'image/png') {
  const canvas = document.createElement('canvas'); canvas.width = board.width; canvas.height = board.height;
  const ctx = canvas.getContext('2d');
  for (const n of board.nodes) {
    if (n.type === 'RECTANGLE') { ctx.fillStyle = n.color; ctx.fillRect(n.x, n.y, n.width, n.height); }
    if (n.type === 'TEXT') {
      ctx.font = `${n.fontWeight} ${n.fontSize}px "${n.fontFamily}"`; ctx.fillStyle = n.color;
      ctx.letterSpacing = `${n.letterSpacing || 0}px`; ctx.textBaseline = 'top'; ctx.textAlign = n.align;
      const x = n.align === 'center' ? n.x + n.width / 2 : n.x;
      n.lines.forEach((line, index) => ctx.fillText(line, x, n.y + index * n.fontSize * n.lineHeight));
    }
    if (n.type === 'IMAGE') {
      const asset = assets.find(a => a.id === n.assetId); if (!asset) throw new Error(`缺少素材 ${n.name}`);
      const image = await loadImage(asset.dataUrl); ctx.drawImage(image, n.x, n.y, n.width, n.height);
    }
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, format, .95));
  if (!blob) throw new Error('图片导出失败。');
  return { canvas, blob, dataUrl: canvas.toDataURL(format, .95) };
}

export async function figmaImage(asset) {
  const image = await loadImage(asset.dataUrl), canvas = document.createElement('canvas');
  const factor = Math.min(1, 4096 / Math.max(image.width, image.height));
  canvas.width = Math.round(image.width * factor); canvas.height = Math.round(image.height * factor);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, converted: factor < 1, originalHash: asset.hash };
}

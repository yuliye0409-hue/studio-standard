import { SCHEMA, uid, safeName, parseDesignMd, buildAnalysisMd, buildDesignSystem, extractLayoutEvidence, composeBoard, validateBoard, layoutModules } from './lib/core.js';
import { readFiles, readDataUrl, makeAsset, analyzeAsset, prepareVisionReference, resolveFonts, textMeasurer, renderBoard, figmaImage, sha256 } from './lib/media.js';
import { saveProject, listProjects } from './lib/storage.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const MAX_ASSETS = 20;
const fresh = () => ({ schema: SCHEMA, id: uid(), name: '我的设计项目', updatedAt: new Date().toISOString(), references: [], assets: [], brand: { logo: null, fonts: [] }, md: '', approvedMd: '', history: [], boards: [], reviewedBoards: [], reports: [], visualAnalysis: null, canvas: { width: 1080, height: 1350 } });
let project, currentView = 'overview', previews = new Map(), saveTimer, busy = false;
let serverStatus = null;
const compositionErrors = new Map();
function boardAssets() { return project.brand?.logo ? [...project.assets, project.brand.logo] : project.assets; }
async function loadBrandFonts() {
  if (!project.brand?.fonts?.length) { document.querySelector('#brand-fonts')?.remove(); return; }
  let style = document.querySelector('#brand-fonts'); if (!style) { style = el('style'); style.id = 'brand-fonts'; document.head.append(style); }
  style.textContent = project.brand.fonts.map(font => `@font-face{font-family:"${font.family.replace(/[^\w -]/g, '')}";src:url(${font.dataUrl}) format("${font.format || 'truetype'}");font-weight:100 900;font-style:normal;font-display:block}`).join('\n');
  const loaded = await Promise.all(project.brand.fonts.map(font => document.fonts.load(`400 24px "${font.family}"`)));
  if (loaded.some(result => !result.length)) throw new Error('品牌字体无法在浏览器加载，请确认文件格式与字体家族名。');
}
function renderBrand() {
  const logo = $('#brandLogoPreview'), fontList = $('#brandFontList'); if (!logo || !fontList) return;
  logo.replaceChildren(); fontList.replaceChildren();
  if (project.brand?.logo) { const image = el('img'); image.src = project.brand.logo.dataUrl; image.alt = '品牌 Logo'; logo.append(image, el('span', 'fine-print', `${project.brand.logo.name} · 原图保留`)); }
  else logo.append(el('span', 'fine-print', '尚未上传品牌 Logo。'));
  if (!project.brand?.fonts?.length) fontList.append(el('span', 'fine-print', '尚未上传品牌字体。'));
  else project.brand.fonts.forEach((font, index) => { const row = el('div', 'brand-font-row'); row.append(el('span', '', `${font.family} · ${font.name}`)); const remove = el('button', 'text-link', '移除'); remove.onclick = () => { project.brand.fonts.splice(index, 1); loadBrandFonts().then(() => { renderBrand(); invalidate('品牌字体已改变，请重新确认规范并生成。'); changed(); }); }; row.append(remove); fontList.append(row); });
}
function toast(text, error = false) { const node = $('#toast'); node.textContent = text; node.classList.add('show'); node.dataset.error = error; clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), error ? 9000 : 3500); }
function fail(error) { console.error(error instanceof Error ? error.message : error); toast(error.message || String(error), true); }
async function task(button, fn) {
  if (busy) return toast('当前任务尚未结束，请稍候。');
  busy = true; $('#composeView').inert = true; const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '正在处理…'; }
  try { await fn(); } catch (error) { fail(error); } finally { busy = false; $('#composeView').inert = false; if (button) { button.disabled = false; button.textContent = label; } renderReview(); }
}
function go(view) {
  currentView = ['overview', 'analyze', 'compose', 'export', 'sop'].includes(view) ? view : 'overview';
  $$('.view').forEach(n => n.classList.toggle('hidden', n.id !== currentView + 'View'));
  if (currentView === 'export') renderReport();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
async function persist() {
  clearTimeout(saveTimer); project.updatedAt = new Date().toISOString(); $('#saveStatus').textContent = '正在保存';
  try { await saveProject(project); $('#saveStatus').textContent = '已保存至本机'; } catch { $('#saveStatus').textContent = '保存失败，请备份'; throw new Error('本地存储失败（可能空间不足）。请立即备份项目 JSON。'); }
}
function changed() { $('#saveStatus').textContent = '有未保存更改'; clearTimeout(saveTimer); saveTimer = setTimeout(() => persist().catch(fail), 500); }
function invalidate(reason) { project.boards = []; project.reviewedBoards = []; project.reports = []; previews.clear(); compositionErrors.clear(); $$('.asset-layout-error').forEach(n => n.remove()); $$('.asset-layout-result').forEach(n => n.remove()); renderBoards(); renderReport(); $('#composeStatus').textContent = reason || ''; }
function progress(message) { $('#analysisProgress').classList.remove('hidden'); $('#analysisProgress').textContent = message; }
function needsReanalysis() { try { return !!project.md && parseDesignMd(project.md).requiresReanalysis; } catch { return false; } }
function approved() { return !!project.md && project.md === project.approvedMd && !needsReanalysis(); }
function renderGate() { $('#composeGate').textContent = approved() ? '规范已确认。原图完整显示；标题、正文、补充信息逐字保留。' : (needsReanalysis() ? '旧规范包含本地识别结果，请先用视觉模型重新分析参考图。' : '请先生成或导入 DESIGN.md，并确认规范。'); $('#composeGate').classList.toggle('ok', approved()); }
function renderSpec() {
  $('#mdEditor').value = project.md;
  $('#mdStatus').textContent = project.md ? (approved() ? '已确认 · 可用于排版' : (needsReanalysis() ? '旧规范需视觉模型重新分析' : '待确认 · 修改参数后请重新确认')) : '尚未生成或导入规范';
  const container = $('#tokenPreview'); container.replaceChildren();
  try {
    if (project.md) {
      const { tokens, warnings } = parseDesignMd(project.md);
      for (const [key, color] of Object.entries(tokens.colors)) { if (key === 'muted') continue; const chip = el('span', 'token-chip'); const dot = el('i'); dot.style.background = color; chip.append(dot, el('span', '', key + ' ' + color)); container.append(chip); }
      if (tokens.aPlus?.modules?.length) {
        const moduleChip = el('span', 'token-chip');
        const reusable = layoutModules(tokens).filter(c => !c.reason && c.module.confidence >= .6).length;
        moduleChip.append(el('span', '', `A+ 模块 ${tokens.aPlus.modules.length} 个 · 可自动匹配 ${reusable} 个`));
        container.append(moduleChip);
      }
      $('#specWarnings').textContent = warnings.join(' ') || '修改后的 MD 会真实影响配色、字体、间距和布局。';
    } else $('#specWarnings').textContent = '规范修改后需要重新确认；旧排版会失效。';
  } catch (error) { $('#specWarnings').textContent = error.message; }
  renderEvidence();
  renderBrand();
  renderHistory(); renderGate(); renderAssets();
}
function renderEvidence() {
  const container = $('#evidenceList'); if (!container) return; container.replaceChildren();
  const roles = [['headline','标题'],['body','正文'],['price','价格/规格'],['product','商品候选'],['decorative','装饰'],['unknown','待确认']];
  const sources = { vision: '视觉模型' };
  const refs = needsReanalysis() ? [] : project.references.filter(r => r.evidence?.elements?.some(item => item.bbox?.source === 'vision'));
  if (!refs.length) { container.append(el('p', 'fine-print', needsReanalysis() ? '旧文字识别结果已停用。原图和文案保留，请重新进行视觉模型分析。' : '模型分析后，这里会显示标题、正文和商品区域及其判断依据；不复制参考图文字。')); return; }
  refs.forEach(ref => { const section = el('div', 'evidence-reference'); section.append(el('strong', '', ref.name)); for (const item of ref.evidence.elements.filter(item => item.bbox?.source === 'vision')) {
    const row = el('div', 'evidence-row'), copy = el('div', 'evidence-copy'), select = document.createElement('select');
    const title = `视觉区域：${roles.find(([value]) => value === item.role)?.[1] || '待确认'}`;
    const source = item.bbox?.source || item.source || 'unknown', confidence = Math.round((Number(item.bbox?.confidence) || 0) * 100);
    row.dataset.elementId = item.id;
    copy.append(el('strong', '', title), el('p', 'evidence-source', `来源：${sources[source] || source} · 置信度：${confidence}%`));
    if (item.bbox.reason) copy.append(el('p', 'fine-print', item.bbox.reason));
    roles.forEach(([value, label]) => { const option = el('option', '', label); option.value = value; option.selected = item.role === value; select.append(option); });
    select.className = 'evidence-role-select'; select.setAttribute('aria-label', `识别用途：${title}`);
    select.onchange = () => { item.role = select.value; project.md = buildAnalysisMd(project.references, project.name, 'vision', project.visualAnalysis); project.approvedMd = ''; invalidate('证据角色已调整，请重新确认规范。'); renderSpec(); changed(); };
    row.append(copy, select); section.append(row);
  } container.append(section); });
}

function bindBrandDropzone(zoneId, inputId, saveFile) {
  const zone = $('#' + zoneId), input = $('#' + inputId);
  const handle = file => task(null, async () => {
    try { if (file) await saveFile(file); }
    finally { input.value = ''; }
  });
  input.onchange = () => handle(input.files[0]);
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('dragging'); });
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, event => {
    event.preventDefault(); zone.classList.remove('dragging');
    if (type === 'drop') handle(event.dataTransfer.files[0]);
  });
}

async function saveBrandLogo(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error('Logo 超过 15MB。');
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error('Logo 仅支持 PNG、JPG、WebP 或 SVG。');
  const logo = await makeAsset(await readDataUrl(file), file.name, { role: 'brand-logo' });
  project.brand = project.brand || { logo: null, fonts: [] }; project.brand.logo = logo;
  invalidate('品牌 Logo 已改变，请重新生成。'); renderBrand(); changed(); await persist(); toast('品牌 Logo 已保存为独立图层。');
}

async function saveBrandFont(file) {
  const family = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\u3400-\u9fff -]/g, ' ').trim() || 'Brand Font';
  if (!/\.(ttf|otf|woff|woff2)$/i.test(file.name) || file.size > 20 * 1024 * 1024) throw new Error('品牌字体仅支持 TTF、OTF、WOFF、WOFF2，且不超过 20MB。');
  const dataUrl = await readDataUrl(file), font = { id: uid(), name: file.name, family, dataUrl, hash: await sha256(dataUrl), format: file.name.split('.').pop().toLowerCase() };
  project.brand = project.brand || { logo: null, fonts: [] }; project.brand.fonts = [...project.brand.fonts.filter(item => item.family !== family), font];
  await loadBrandFonts(); invalidate('品牌字体已改变，请重新生成。'); renderBrand(); changed(); await persist(); toast(`品牌字体 ${family} 已加载；Figma 中请安装并核对原字体。`);
}
function renderHistory() {
  const list = $('#historyList'); list.replaceChildren();
  if (!project.history.length) list.append(el('p', '', '确认规范后，在本机保留最近 10 个版本。'));
  project.history.forEach((entry, index) => { const row = el('div', 'history-item'); const button = el('button', 'text-link', '恢复此版本'); button.onclick = () => { project.md = entry.md; project.approvedMd = ''; invalidate('已恢复规范，请重新确认。'); renderSpec(); changed(); }; row.append(el('span', '', `版本 ${entry.version} · ${new Date(entry.date).toLocaleString()}`), button); list.append(row); });
}
function setMd(md) { project.md = md; project.approvedMd = ''; invalidate('规范已改变，需要重新生成作品。'); renderSpec(); changed(); }
function renderReferences() {
  $('#referenceCount').textContent = `${project.references.length} 张`;
  const list = $('#referenceList'); list.replaceChildren();
  for (const ref of project.references) {
    const row = el('div', 'reference-item'), image = el('img'); image.src = ref.dataUrl; image.alt = ref.name;
    const desc = el('div'); desc.append(el('strong', '', ref.name), el('small', '', `${ref.width} × ${ref.height}${ref.analysis ? ' · 已测量' : ''}${ref.aPlusModules?.length ? ' · 已模型分析' : ''}`));
    const remove = el('button', '', '×'); remove.title = '移除参考图'; remove.onclick = async () => { if (busy) return; project.references = project.references.filter(r => r.id !== ref.id); project.approvedMd = ''; renderReferences(); renderGate(); changed(); toast('参考集已变化，请重新分析或重新确认现有规范。'); };
    row.append(image, desc, remove); list.append(row);
  }
}
async function uploadReferences(files) {
  if (!files.length) return;
  if (files.some(file => !/^image\/(png|jpeg|webp)$/.test(file.type))) throw new Error('参考设计仅支持 PNG、JPG、WebP 图片，请将网页或 PDF 截图后上传。');
  const added = await readFiles(files, 'reference', progress);
  if (added.length + project.references.length > 20) throw new Error('每个项目最多 20 张参考图片，请拆分项目。');
  project.references.push(...added); project.approvedMd = ''; renderReferences(); renderGate(); await persist(); progress(`已读取 ${added.length} 张画面，可开始分析。`);
}
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  let result; try { result = await response.json(); } catch { throw new Error('本机服务返回无效响应，请确认 v0.3 服务正在运行。'); }
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}
async function analyze() {
  if (!project.references.length) throw new Error('请先上传参考设计图片。');
  await refreshStatus();
  if (!serverStatus?.vision?.configured) {
    $('#settingsDialog').showModal();
    progress('请先配置视觉模型。原有规范和作品未改变。');
    toast('请先配置支持图片输入的视觉模型，再分析参考图。不会使用本地文字识别替代。', true);
    return;
  }
  const measured = [], images = [], details = [];
  for (const [index, reference] of project.references.entries()) {
    progress(`准备参考 ${index + 1}/${project.references.length}：${reference.name}`);
    const { ocr, evidence, aPlusModules, ...original } = reference;
    const ref = await analyzeAsset(original), prepared = await prepareVisionReference(ref);
    ref.evidence = extractLayoutEvidence(ref);
    measured.push(ref); images.push(prepared.overview);
    if (prepared.tiles.length) details.push({ referenceIndex: index, tiles: prepared.tiles });
  }
  const tileCount = details.reduce((sum, detail) => sum + detail.tiles.length, 0);
  if (!confirm(`将向 ${serverStatus.vision.baseUrl} 发送 ${images.length} 张参考图总览${tileCount ? `和 ${tileCount} 张局部切片（辅助看清长图）` : ''}用于模型分析，可能产生服务商费用。是否继续？`)) { progress('已取消发送，原有规范未改变。'); return; }
  progress('视觉模型正在识别整套风格、逐图模块边界和图文槽位…');
  const visual = await api('vision', { images, details });
  for (const [index, ref] of measured.entries()) {
    const analyzed = visual.references[index];
    ref.aPlusModules = analyzed.modules;
    ref.evidence.elements = analyzed.elements.map((item, itemIndex) => ({ id: `vision-${itemIndex + 1}`, role: item.role, text: '', bbox: { x: Number(item.bbox[0]), y: Number(item.bbox[1]), width: Number(item.bbox[2]), height: Number(item.bbox[3]), confidence: Number(item.confidence ?? .5), source: 'vision', reason: item.reason || '' } }));
  }
  const md = buildAnalysisMd(measured, project.name, 'vision', visual);
  parseDesignMd(md);
  project.references = measured; project.analysisMode = 'vision'; project.visualAnalysis = visual;
  setMd(md);
  await persist(); renderReferences(); progress('模型规范已生成。请核对模块、槽位和字体，再确认进入排版。');
  toast('已使用视觉模型分析；未使用本地文字识别。');
}

function renderAssets() {
  const list = $('#assetList'); list.replaceChildren();
  let modules = []; try { if (project.md) modules = layoutModules(parseDesignMd(project.md).tokens); } catch { /* Invalid MD is reported by the specification editor. */ }
  $('#assetCount').textContent = `${project.assets.length} / ${MAX_ASSETS} 张`;
  $('#assetInput').disabled = project.assets.length >= MAX_ASSETS;
  $('#assetEmpty').classList.toggle('hidden', project.assets.length > 0);
  for (const [index, asset] of project.assets.entries()) {
    asset.copy = { title: '', body: '', detail: '', ...(asset.copy || {}) };
    const card = el('article', 'asset-card'); card.dataset.assetId = asset.id;
    const heading = el('div', 'asset-card-heading'), image = el('img'); image.src = asset.dataUrl; image.alt = asset.name;
    const meta = el('div'); meta.append(el('h3', '', `图片 ${index + 1} · ${asset.name}`), el('p', 'fine-print', `${asset.width} × ${asset.height}px · 原图完整保留`)); heading.append(image, meta); card.append(heading);
    const select = el('select'); select.dataset.field = 'layout'; select.id = `layout-${asset.id}`; select.setAttribute('aria-label', `图片 ${index + 1} 的版式匹配`);
    for (const [value, label, disabled] of [['auto', '自动匹配 · 按原图比例与槽位容量', false], ['generic', '通用版式 · 不复用参考槽位', false], ...modules.map(c => [c.key, c.label + (c.reason ? `（不可用：${c.reason}）` : ''), Boolean(c.reason)])]) { const option = el('option', '', label); option.value = value; option.disabled = disabled; select.append(option); }
    if (asset.layoutModuleKey && ![...select.options].some(o => o.value === asset.layoutModuleKey)) { const option = el('option', '', '原模块已变化，请重新选择'); option.value = asset.layoutModuleKey; select.append(option); }
    select.value = asset.layoutModuleKey || 'auto'; select.onchange = () => { asset.layoutModuleKey = select.value; invalidate('版式匹配已改变，请重新生成并检查。'); changed(); };
    const layoutLabel = el('label', 'field-label', '匹配参考版式'); layoutLabel.htmlFor = select.id; card.append(layoutLabel, select);
    const match = project.boards.find(b => b.assetId === asset.id)?.layoutMatch;
    if (match) card.append(el('p', 'fine-print asset-layout-result', match.kind === 'module' ? `已匹配：${match.label} · 原图槽位利用率 ${Math.round(match.imageFit * 100)}%` : `${match.label}：${match.reason}`));
    if (compositionErrors.has(asset.id)) { const error = el('p', 'asset-layout-error', compositionErrors.get(asset.id)); error.setAttribute('role', 'alert'); card.append(error); }
    for (const [field, label, rows, hint] of [['title', '标题 · 必填', 2, '填写这张图片的标题'], ['body', '正文 / 卖点', 4, '填写这张图片的卖点，支持换行'], ['detail', '补充信息', 2, '型号、价格、说明等；可留空']]) {
      const input = el('textarea'); input.id = `copy-${asset.id}-${field}`; input.dataset.field = field; input.rows = rows; input.value = asset.copy[field] || ''; input.placeholder = hint; input.required = field === 'title';
      const caption = el('label', 'field-label', label); caption.htmlFor = input.id;
      input.oninput = () => { asset.copy[field] = input.value; input.removeAttribute('aria-invalid'); invalidate(`图片 ${index + 1} 的文案已修改，请重新生成并确认。`); changed(); };
      card.append(caption, input);
    }
    const actions = el('div', 'button-row'), replacement = el('label', 'secondary file-button', '替换图片'), file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.setAttribute('aria-label', `替换图片 ${index + 1}`);
    file.onchange = () => task(null, async () => { try { if (!file.files.length) return; const [next] = await readFiles([...file.files], 'asset'); Object.assign(asset, next, { id: asset.id, copy: asset.copy }); invalidate('图片已替换，文案保留，请重新生成并确认。'); renderAssets(); await persist(); } finally { file.value = ''; } });
    replacement.append(file); actions.append(replacement);
    for (const [label, offset] of [['上移', -1], ['下移', 1]]) { const button = el('button', 'text-link', label); button.disabled = index + offset < 0 || index + offset >= project.assets.length; button.onclick = () => { if (busy) return; const position = project.assets.findIndex(a => a.id === asset.id), target = position + offset; if (target < 0 || target >= project.assets.length) return; [project.assets[position], project.assets[target]] = [project.assets[target], project.assets[position]]; invalidate('图文顺序已调整，请重新生成并确认。'); renderAssets(); changed(); }; actions.append(button); }
    const remove = el('button', 'text-link', '删除'); remove.onclick = () => { if (busy || !confirm(`删除图片 ${index + 1}「${asset.name}」及其文案？`)) return; project.assets = project.assets.filter(a => a.id !== asset.id); invalidate('图文已删除，请重新生成并确认。'); renderAssets(); changed(); }; actions.append(remove); card.append(actions); list.append(card);
  }
}
async function compose() {
  if (!approved()) { go('analyze'); throw new Error('请先确认规范。'); }
  if (!project.assets.length) throw new Error('请添加未排版的商品图片和文案。');
  if (project.assets.length > MAX_ASSETS) throw new Error('每套最多 20 张图片，请删除多余素材或拆分项目。');
  const missing = project.assets.findIndex(asset => !String(asset.copy?.title || '').trim());
  if (missing >= 0) { const input = $('#assetList').children[missing].querySelector('[data-field="title"]'); input.setAttribute('aria-invalid', 'true'); input.scrollIntoView({ block: 'center' }); throw new Error(`请填写图片 ${missing + 1}「${project.assets[missing].name}」的标题。`); }
  const { tokens } = parseDesignMd(project.md), measure = textMeasurer();
  invalidate('正在按图片比例与模块槽位匹配排版…');
  const boards = [], reports = [], pendingPreviews = new Map();
  await document.fonts.load('600 40px Inter'); await document.fonts.load('400 24px Inter');
  for (const [index, asset] of project.assets.entries()) {
    $('#composeStatus').textContent = `正在排版 ${index + 1}/${project.assets.length}：${asset.name}`;
    const effectiveTokens = structuredClone(tokens);
    const brandFamily = project.brand?.fonts?.[0]?.family;
    if (brandFamily) { effectiveTokens.typography.title.family = brandFamily; effectiveTokens.typography.body.family = brandFamily; }
    const fonts = await resolveFonts(effectiveTokens, Object.values(asset.copy).join(''));
    let board;
    try { board = composeBoard({ asset, copy: asset.copy, tokens: effectiveTokens, ...project.canvas, measure, fonts, brandLogo: project.brand?.logo, id: uid(), moduleKey: asset.layoutModuleKey || 'auto', assetIndex: index }); }
    catch (error) { compositionErrors.set(asset.id, error.message); $('#composeStatus').textContent = `图片 ${index + 1}「${asset.name}」未生成，请检查该图的版式匹配说明。`; renderAssets(); $('#assetList').querySelector(`[data-asset-id="${asset.id}"]`)?.scrollIntoView({ block: 'nearest' }); throw error; }
    board.mdHash = await sha256('data:text/plain;base64,' + btoa(unescape(encodeURIComponent(project.md))));
    if (brandFamily) board.warnings.push(`品牌字体已锁定为 ${brandFamily}；Figma 端需安装同名字体。`);
    for (const role of ['title', 'body']) if (!tokens.typography[role].family.split(',').map(s => s.replace(/['"]/g, '').trim()).includes(fonts[role])) board.warnings.push(`字体替换：${tokens.typography[role].family} → ${fonts[role]}。`);
    const report = validateBoard(board, asset); if (!report.ok) throw new Error(report.errors.join('\n'));
    const rendered = await renderBoard(board, boardAssets()); pendingPreviews.set(board.id, rendered.dataUrl); boards.push(board); reports.push(report);
  }
  project.boards = boards; project.reviewedBoards = []; project.reports = reports; previews = pendingPreviews; compositionErrors.clear(); renderBoards(); renderAssets(); renderReport(); await persist();
  $('#composeStatus').textContent = `已生成 ${boards.length} 张作品。请放大检查每张图，逐张勾选确认后导出。`; toast('排版完成，请逐张确认图文与排版。');
}
function allReviewed() { return approved() && project.boards.length > 0 && project.boards.length === project.assets.length && project.boards.every(board => project.reviewedBoards?.includes(board.id)); }
function renderReview() {
  if (!project) return;
  const count = project.boards.filter(board => project.reviewedBoards?.includes(board.id)).length;
  $('#reviewStatus').textContent = project.boards.length ? `已确认 ${count} / ${project.boards.length} 张 · 修改图片、文案或规范后需重新生成并确认` : '生成排版后，请逐张检查并确认。';
  $('#finishReviewBtn').disabled = !allReviewed();
  for (const id of ['imagesZipBtn', 'packageBtn', 'figmaJsonBtn']) $('#' + id).disabled = !allReviewed();
}
function renderBoards() {
  const grid = $('#boardGrid'); grid.replaceChildren(); $('#boardCount').textContent = project.boards.length ? `${project.boards.length} 张 · ${project.canvas.width} × ${project.canvas.height}px` : '尚未生成';
  renderReview();
  if (!project.boards.length) { const empty = el('div', 'empty-board'); empty.append(el('span', '', '▧'), el('h3', '', '这里，只展示你的真实作品。'), el('p', '', '确认规范并上传素材后，生成可下载的画板。')); grid.append(empty); return; }
  project.boards.forEach((board, index) => {
    const card = el('article', 'board-card'), button = el('button', 'board-image-button'), image = el('img'); image.src = previews.get(board.id) || ''; image.alt = board.copy.title; button.append(image);
    button.onclick = () => { $('#largePreview').src = previews.get(board.id); $('#imageDialog').showModal(); };
    const caption = el('div', 'board-caption'), download = el('button', 'text-link', 'PNG ↓'); download.onclick = () => task(download, async () => { ensureExportable(); const result = await renderBoard(board, boardAssets()); downloadBlob(result.blob, `${String(index + 1).padStart(2, '0')}-${safeName(board.name)}.png`); });
    caption.append(el('strong', '', board.copy.title), download); card.append(button, caption);
    if (board.layoutMatch) card.append(el('p', 'fine-print board-layout-match', `${board.width} × ${board.height}px · ${board.layoutMatch.label}${board.layoutMatch.kind === 'generic' ? ' · ' + board.layoutMatch.reason : ''}`));
    const review = el('label', 'board-review'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = project.reviewedBoards?.includes(board.id) || false;
    checkbox.onchange = () => { project.reviewedBoards = (project.reviewedBoards || []).filter(id => id !== board.id); if (checkbox.checked) project.reviewedBoards.push(board.id); renderReview(); changed(); };
    review.append(checkbox, document.createTextNode(`第 ${index + 1} 张 · 已检查图文和排版`)); card.append(review);
    if (board.warnings.length) card.append(el('p', 'board-warning', board.warnings.join(' '))); grid.append(card);
  });
}
function renderReport() {
  const list = $('#validationReport'); list.replaceChildren();
  if (!project.boards.length) { list.append(el('p', 'muted', '生成排版后显示真实检查结果，不预设通过。')); return; }
  project.reports = project.boards.map(b => validateBoard(b, project.assets.find(a => a.id === b.assetId)));
  project.reports.forEach((report, index) => { const row = el('div', 'validation-item'); row.append(el('strong', '', `${report.ok ? '✓' : '×'} ${project.boards[index].name}`), el('p', '', report.ok ? report.checks.join(' · ') : report.errors.join('\n'))); if (report.warnings.length) row.append(el('p', '', '需人工查看：' + report.warnings.join('\n'))); list.append(row); });
}
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob), anchor = el('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
function downloadText(text, name, type = 'text/plain;charset=utf-8') { downloadBlob(new Blob([text], { type }), name); }
function ensureExportable() {
  if (!approved() || !project.boards.length) throw new Error('请先确认规范并生成真实作品。');
  if (!allReviewed()) throw new Error('请先在 STEP 3 逐张检查并勾选确认排版，再导出整套作品。');
  for (const board of project.boards) {
    const asset = project.assets.find(a => a.id === board.assetId); if (!asset) throw new Error('缺少商品素材。');
    const report = validateBoard(board, asset); if (!report.ok) throw new Error(report.errors.join('\n'));
  }
}
async function figmaPackage() {
  ensureExportable(); const assets = {};
  for (const asset of boardAssets()) assets[asset.id] = { id: asset.id, name: asset.name, hash: asset.hash, originalDataUrl: asset.dataUrl, ...await figmaImage(asset) };
  return { schema: SCHEMA, project: project.name, createdAt: new Date().toISOString(), designMd: project.md, tokens: parseDesignMd(project.md).tokens, designSystem: buildDesignSystem(project.references, project.visualAnalysis), referenceMap: project.references.map(r => ({ name: r.name, hash: r.hash, evidence: r.evidence })), brand: project.brand, boards: project.boards, assets, reports: project.reports };
}
async function addPlugin(zip, prefix = '') {
  for (const name of ['manifest.json', 'code.js', 'ui.html', 'README.md']) { const response = await fetch('/figma-plugin/' + name); if (!response.ok) throw new Error('缺少 Figma 插件文件 ' + name); zip.file(prefix + name, await response.text()); }
}
async function exportZip(kind) {
  ensureExportable(); const zip = new JSZip(), jpg = $('#exportFormat').value === 'jpg';
  for (const [index, board] of project.boards.entries()) { $('#exportStatus').textContent = `正在导出图片 ${index + 1}/${project.boards.length}`; const result = await renderBoard(board, boardAssets(), jpg ? 'image/jpeg' : 'image/png'); zip.file(`images/${String(index + 1).padStart(2, '0')}-${safeName(board.name)}.${jpg ? 'jpg' : 'png'}`, result.blob); }
  if (kind === 'full') {
    zip.file('DESIGN.md', project.md); zip.file('design-system.json', JSON.stringify(buildDesignSystem(project.references, project.visualAnalysis), null, 2)); zip.file('reference-map.json', JSON.stringify(project.references.map(r => ({ name: r.name, hash: r.hash, evidence: r.evidence })), null, 2)); zip.file('project.json', JSON.stringify(project));
    zip.file('figma-import.json', JSON.stringify(await figmaPackage())); zip.file('validation-report.json', JSON.stringify(project.reports, null, 2));
    for (const [index, asset] of project.assets.entries()) { const extension = asset.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : asset.dataUrl.startsWith('data:image/webp') ? 'webp' : 'png'; zip.file(`assets/${index + 1}-${safeName(asset.name)}.${extension}`, asset.dataUrl.split(',')[1], { base64: true }); }
    if (project.brand?.logo) zip.file(`brand/logo-${safeName(project.brand.logo.name)}`, project.brand.logo.dataUrl.split(',')[1], { base64: true });
    for (const font of project.brand?.fonts || []) zip.file(`brand/fonts/${safeName(font.name)}`, font.dataUrl.split(',')[1], { base64: true });
    await addPlugin(zip, 'figma-plugin/'); zip.file('SOP.md', await (await fetch('/SOP.md')).text());
  }
  $('#exportStatus').textContent = '正在打包 ZIP…'; downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), safeName(project.name) + (kind === 'full' ? '-完整交付包.zip' : '-图片.zip')); $('#exportStatus').textContent = '导出完成。已打包实际图片与文件，不是多次模拟下载。';
}
async function refreshStatus() {
  const res = await fetch('/api/status'); if (!res.ok) throw new Error('本机服务不可用。'); serverStatus = await res.json();
  if (serverStatus.version !== '0.3.0') throw new Error('当前端口不是 v0.3 服务，请按 README 重启。');
  $('#connectionDot').textContent = serverStatus.vision.configured ? '●' : '○'; $('#apiBase').value = serverStatus.vision.baseUrl; $('#apiModel').value = serverStatus.vision.model; $('#apiProtocol').value = serverStatus.vision.protocol;
}
async function showProjects() {
  await persist(); $('#projectNameInput').value = project.name; const list = $('#projectList'); list.replaceChildren();
  for (const item of await listProjects()) { const button = el('button', 'project-choice'); button.append(el('span', '', item.name + (item.id === project.id ? ' · 当前' : '')), el('small', '', `${item.assets.length} 个素材`)); button.onclick = async () => { if (busy) return; await persist(); await useProject(item); $('#projectDialog').close(); }; list.append(button); }
  $('#projectDialog').showModal();
}
async function useProject(value) {
  project = value;
  if (needsReanalysis()) { project.approvedMd = ''; project.boards = []; project.reviewedBoards = []; project.reports = []; }
  project.references = (project.references || []).map(reference => {
    const { ocr, ...original } = reference;
    if (original.analysis) original.evidence = extractLayoutEvidence(original);
    return original;
  });
  compositionErrors.clear();
  project.assets = (Array.isArray(project.assets) ? project.assets : []).map(asset => ({ ...asset, copy: { title: '', body: '', detail: '', ...(asset.copy || {}) } }));
  project.reviewedBoards = Array.isArray(project.reviewedBoards) ? project.reviewedBoards : [];
  previews.clear();
  $('#projectMenuBtn').replaceChildren(document.createTextNode(project.name + ' '), el('span', '', '⌄'));
  $('#canvasWidth').value = project.canvas.width; $('#canvasHeight').value = project.canvas.height; syncCanvasPreset();
  renderReferences(); renderAssets(); renderSpec();
  await loadBrandFonts(); renderBrand();
  for (const board of project.boards) { try { const result = await renderBoard(board, boardAssets()); previews.set(board.id, result.dataUrl); } catch { invalidate('历史素材缺失，请重新生成。'); break; } }
  renderBoards(); renderReport(); await persist();
}
async function restore(file) {
  if (!file) return; if (file.size > 150 * 1024 * 1024) throw new Error('项目备份超过 150MB。');
  let imported; try { imported = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效 JSON。'); }
  if (imported.schema !== SCHEMA || !Array.isArray(imported.references) || !Array.isArray(imported.assets) || imported.references.length > 20 || imported.assets.length > MAX_ASSETS) throw new Error('备份格式无效，或超过每套 20 张图片上限；旧项目请先拆分后备份。');
  for (const asset of [...imported.references, ...imported.assets]) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(asset.dataUrl || '')) throw new Error('项目缺少有效原始图片。');
    if (await sha256(asset.dataUrl) !== asset.hash) throw new Error('备份素材校验不匹配。');
  }
  const restored = { ...fresh(), id: uid(), name: String(imported.name || '恢复的项目') + ' · 恢复', references: imported.references, assets: imported.assets.map(asset => ({ ...asset, copy: { title: '', body: '', detail: '', ...(asset.copy || {}) } })), brand: imported.brand || { logo: null, fonts: [] }, md: String(imported.md || ''), analysisMode: imported.analysisMode || null, visualAnalysis: imported.visualAnalysis || null, canvas: imported.canvas || { width: 1080, height: 1350 }, approvedMd: '', boards: [], reports: [], history: [] };
  if (restored.md) parseDesignMd(restored.md);
  await useProject(restored); $('#projectDialog').close(); go('analyze'); toast('素材与文案已恢复，请重新确认规范后生成。');
}
async function loadSop() {
  const text = await (await fetch('/SOP.md')).text(), container = $('#sopContent'); container.replaceChildren();
  for (const block of text.split(/\n\n+/)) { if (!block.trim()) continue; if (block.startsWith('# ')) continue; const tag = block.startsWith('## ') ? 'h2' : block.startsWith('### ') ? 'h3' : 'p'; const node = el(tag, '', block.replace(/^#{2,3} /, '').replace(/`/g, '')); node.style.whiteSpace = 'pre-wrap'; container.append(node); }
}

function syncCanvasPreset() {
  const preset = $('#sizePreset'), value = `${project.canvas.width}x${project.canvas.height}`;
  let custom = preset.querySelector('option[value="custom"]');
  if (!custom) { custom = el('option'); custom.value = 'custom'; preset.append(custom); }
  custom.textContent = `自定义 · ${project.canvas.width} × ${project.canvas.height}px`;
  preset.value = [...preset.options].some(o => o.value === value) ? value : 'custom';
}

function wire() {
  $$('[data-view]').forEach(n => n.onclick = e => { e.preventDefault(); go(n.dataset.view); });
  $('#referenceInput').onchange = e => task($('#analyzeBtn'), async () => { await uploadReferences([...e.target.files]); e.target.value = ''; });
  for (const type of ['dragenter', 'dragover']) $('#referenceDropzone').addEventListener(type, e => { e.preventDefault(); $('#referenceDropzone').classList.add('dragging'); });
  for (const type of ['dragleave', 'drop']) $('#referenceDropzone').addEventListener(type, e => { e.preventDefault(); $('#referenceDropzone').classList.remove('dragging'); if (type === 'drop') task($('#analyzeBtn'), () => uploadReferences([...e.dataTransfer.files])); });

  $('#analyzeBtn').onclick = () => task($('#analyzeBtn'), async () => { try { await analyze(); } catch (error) { progress(`分析失败：${error.message || '请检查视觉模型接口'}。未生成替代规范；原有规范和作品未改变。`); throw error; } });
  $('#mdInput').onchange = e => task(null, async () => { const file = e.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) throw new Error('MD 文件超过 2MB。'); const md = await file.text(); parseDesignMd(md); setMd(md); e.target.value = ''; await persist(); });
  bindBrandDropzone('brandLogoDropzone', 'brandLogoInput', saveBrandLogo);
  bindBrandDropzone('brandFontDropzone', 'brandFontInput', saveBrandFont);
  $('#loadAppleBtn').onclick = () => task($('#loadAppleBtn'), async () => { const md = await (await fetch('/UI-DESIGN.md')).text(); parseDesignMd(md); setMd(md); await persist(); toast('已载入你提供的 Apple 规范；确认后才会用于新作品。'); });
  $('#mdEditor').oninput = () => { project.md = $('#mdEditor').value; project.approvedMd = ''; invalidate('规范已变化，请重新确认。'); renderGate(); $('#mdStatus').textContent = '已修改 · 待确认'; changed(); };
  $('#mdEditor').onblur = renderSpec;
  $('#approveBtn').onclick = () => task($('#approveBtn'), async () => { if (parseDesignMd(project.md).requiresReanalysis) throw new Error('旧规范包含本地分析或文字识别结果，请使用视觉模型重新分析参考图后再确认。'); project.approvedMd = project.md; const last = project.history.at(-1); if (!last || last.md !== project.md) project.history.push({ version: (last?.version || 0) + 1, date: new Date().toISOString(), md: project.md }); project.history = project.history.slice(-10); renderSpec(); await persist(); go('compose'); });
  $('#downloadMdBtn').onclick = () => { try { parseDesignMd(project.md); downloadText(project.md, 'DESIGN.md'); } catch (e) { fail(e); } };
  $('#assetInput').onchange = e => task($('#composeBtn'), async () => { try { const files = [...e.target.files]; if (!files.length) return; if (project.assets.length + files.length > MAX_ASSETS) throw new Error(`每套最多 20 张图片，当前 ${project.assets.length} 张，还能添加 ${MAX_ASSETS - project.assets.length} 张。本次未添加任何图片。`); const added = await readFiles(files, 'asset'); added.forEach(a => { a.copy = { title: '', body: '', detail: '' }; }); project.assets.push(...added); invalidate('图片已添加，请逐张填写对应文案。'); renderAssets(); await persist(); } finally { e.target.value = ''; } });

  for (const id of ['canvasWidth', 'canvasHeight']) $('#' + id).onchange = () => { project.canvas = { width: Number($('#canvasWidth').value), height: Number($('#canvasHeight').value) }; syncCanvasPreset(); invalidate('画布尺寸已改变，请重新生成。'); changed(); };
  $('#sizePreset').onchange = e => { if (e.target.value === 'custom') return; const [width, height] = e.target.value.split('x').map(Number); project.canvas = { width, height }; $('#canvasWidth').value = width; $('#canvasHeight').value = height; syncCanvasPreset(); invalidate('画布尺寸已改变，请重新生成。'); changed(); };

  $('#composeBtn').onclick = () => task($('#composeBtn'), compose);
  $('#finishReviewBtn').onclick = () => task($('#finishReviewBtn'), async () => { ensureExportable(); await persist(); go('export'); });
  $('#imagesZipBtn').onclick = () => task($('#imagesZipBtn'), () => exportZip('images'));
  $('#packageBtn').onclick = () => task($('#packageBtn'), () => exportZip('full'));
  $('#figmaJsonBtn').onclick = () => task($('#figmaJsonBtn'), async () => downloadText(JSON.stringify(await figmaPackage()), 'figma-import.json', 'application/json'));
  $('#pluginZipBtn').onclick = () => task($('#pluginZipBtn'), async () => { const zip = new JSZip(); await addPlugin(zip); downloadBlob(await zip.generateAsync({ type: 'blob' }), 'Studio-Standard-Figma-Importer.zip'); });
  $('#exportProjectBtn').onclick = () => task($('#exportProjectBtn'), async () => { await persist(); downloadText(JSON.stringify(project), safeName(project.name) + '-project.json', 'application/json'); });
  $('#saveBtn').onclick = () => persist().then(() => toast('项目已保存至本机浏览器。')).catch(fail);
  $('#projectMenuBtn').onclick = () => showProjects().catch(fail);
  $('#renameProjectBtn').onclick = () => task($('#renameProjectBtn'), async () => { const name = $('#projectNameInput').value.trim(); if (!name) throw new Error('项目名称不能为空。'); project.name = name; $('#projectMenuBtn').replaceChildren(document.createTextNode(name + ' '), el('span', '', '⌄')); await persist(); toast('项目已重命名。'); });
  $('#newProjectBtn').onclick = () => task($('#newProjectBtn'), async () => { await persist(); await useProject(fresh()); $('#projectDialog').close(); go('analyze'); });
  $('#projectInput').onchange = e => task(null, async () => { await restore(e.target.files[0]); e.target.value = ''; });
  const settings = () => { $('#settingsDialog').showModal(); refreshStatus().catch(fail); };
  $('#settingsBtn').onclick = settings; $('#footerSettingsBtn').onclick = settings;
  $('#saveSettingsBtn').onclick = () => task($('#saveSettingsBtn'), async () => { const result = await api('config', { baseUrl: $('#apiBase').value, model: $('#apiModel').value, protocol: $('#apiProtocol').value, key: $('#apiKey').value }); $('#apiKey').value = ''; await refreshStatus(); $('#settingsStatus').textContent = result.configured ? '接口已配置（尚未发送图片验证）；分析前会明确征求发送确认。' : '还缺少 API Key。'; });
  window.addEventListener('pagehide', () => { if (project) saveProject(project).catch(() => {}); });
}

async function start() {
  wire(); const projects = await listProjects(); await useProject(projects[0] || fresh());
  await refreshStatus(); await loadSop();
  document.body.dataset.ready = 'true';
}
start().catch(error => { $('#saveStatus').textContent = '启动异常'; fail(error); });

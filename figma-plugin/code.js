/* Native Figma importer. No network or provider keys. */
figma.showUI(__html__, { width: 480, height: 530, themeColors: true });
const hexColor = hex => { if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('无效图层颜色'); return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 }; };
function validatePaths(node) {
  if (!Array.isArray(node.vectorPaths) || !node.vectorPaths.length || node.vectorPaths.length > 32 || typeof node.filled !== 'boolean' || !Number.isFinite(node.strokeWidth) || node.strokeWidth < 0 || node.strokeWidth > 100 || (!node.filled && !node.strokeWidth)) throw new Error('矢量路径或描边无效。');
  for (const p of node.vectorPaths) {
    if (!['EVENODD','NONZERO','NONE'].includes(p.windingRule) || typeof p.data !== 'string' || p.data.length > 20000 || /[^MLQCZ\d\s.,+eE-]/.test(p.data)) throw new Error('矢量路径格式无效。');
    if(node.filled&&(p.windingRule==='NONE'||!p.data.trim().endsWith('Z')))throw new Error('填充矢量路径必须闭合。');
    const tokens=p.data.match(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)||[];
    if(tokens[0]!=='M'||tokens.length<4) throw new Error('矢量路径缺少起点或线段。');
    for(let i=0;i<tokens.length;) { const count={M:2,L:2,Q:4,C:6,Z:0}[tokens[i++]]; if(count===undefined)throw new Error('矢量路径命令无效。'); const values=tokens.slice(i,i+count).map(Number);i+=count;if(values.length!==count||values.some((n,j)=>!Number.isFinite(n)||n<0||n>(j%2?node.height:node.width)+.001))throw new Error('矢量路径坐标越界。'); }
  }
}
let importing = false;
figma.ui.onmessage = async message => {
  if (message.type !== 'import' || importing) return;
  importing = true; const created = [], notes = [];
  try {
    const data = message.data;
    const reconstruction = ['studio-reconstruction/1', 'studio-reconstruction/2'].includes(data.schema);
    if ((!reconstruction && data.schema !== 'studio-standard/2') || !Array.isArray(data.boards) || !data.boards.length || data.boards.length > 30 || !data.assets) throw new Error('不支持的文件格式或画板数量。请使用工作台导出的 figma-import.json。');
    for (const board of data.boards) {
      if (!Number.isFinite(board.width) || !Number.isFinite(board.height) || board.width < (reconstruction ? 1 : 320) || board.height < (reconstruction ? 1 : 320) || board.width > (reconstruction ? 16384 : 4096) || board.height > (reconstruction ? 16384 : 4096) || board.width * board.height > 32000000 || !Array.isArray(board.nodes) || board.nodes.length > (reconstruction ? 250 : 100)) throw new Error('画板数据不合法。');
      for (const node of board.nodes) {
        if (!(reconstruction ? ['RECTANGLE', 'ELLIPSE', 'TEXT', 'IMAGE', 'VECTOR'] : ['RECTANGLE', 'TEXT', 'IMAGE']).includes(node.type)) throw new Error('包含未支持的图层类型。');
        if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0 || node.x < 0 || node.y < 0 || node.x + node.width > board.width + 1 || node.y + node.height > board.height + 1) throw new Error('存在无效或越界图层。');
        if (node.type === 'IMAGE' && !data.assets[node.assetId]?.bytes?.length) throw new Error('缺少图片二进制数据。');
        if (node.type === 'TEXT' && (typeof node.characters !== 'string' || node.characters.length > 50000)) throw new Error('文字图层不合法。');
        if (node.type === 'TEXT' && (!Number.isFinite(node.fontSize) || node.fontSize < 1 || node.fontSize > 2048 || typeof node.fontFamily !== 'string' || !Number.isFinite(node.lineHeight) || node.lineHeight < 1 || node.lineHeight > 3)) throw new Error('文字字号、字体或行高无效。');
        if (node.type !== 'IMAGE') hexColor(node.color);
        if (node.type === 'VECTOR') validatePaths(node);
      }
    }
    if (reconstruction) for (const asset of Object.values(data.assets)) {
      const b = asset.bytes;
      if (!b || b.length < 24 || ![137,80,78,71,13,10,26,10].every((n,i) => b[i] === n)) throw new Error('图片资源不是有效 PNG。');
      const dimension = offset => b[offset] * 16777216 + b[offset + 1] * 65536 + b[offset + 2] * 256 + b[offset + 3];
      if (![dimension(16), dimension(20)].every(n => n > 0 && n <= 4096)) throw new Error('单个图片资源超过 4096px，请使用新版工作台重新导出切片。');
    }
    if (data.schema === 'studio-reconstruction/2' && !data.boards.some(b => b.nodes.some(n => ['TEXT','RECTANGLE','ELLIPSE','VECTOR'].includes(n.type)))) throw new Error('文件没有可编辑文字或矢量图层，请回工作台分析并启用图层后重新导出。');
    const available = (await figma.listAvailableFontsAsync()).map(x => x.fontName);
    const findFont = async node => {
      const cjk = /[\u2e80-\u9fff]/.test(node.characters);
      const candidates = [node.fontFamily, ...(cjk ? ['Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Noto Sans CJK SC'] : []), 'Inter', 'Arial'];
      let font;
      for (const family of candidates) {
        const variants = available.filter(f => f.family.toLowerCase() === family.toLowerCase());
        if (!variants.length) continue;
        const styles = node.fontWeight >= 650 ? ['Bold', 'Semi Bold', 'Semibold', 'Regular'] : node.fontWeight >= 550 ? ['Semi Bold', 'Semibold', 'Medium', 'Regular'] : ['Regular', 'Normal', 'Book'];
        font = styles.map(style => variants.find(v => v.style.toLowerCase() === style.toLowerCase())).find(Boolean) || variants[0]; break;
      }
      if (!font) throw new Error('Figma 找不到任何可用字体。请安装项目所用字体后重试。');
      await figma.loadFontAsync(font);
      if (font.family !== node.fontFamily) notes.push(`${node.name} 字体替换：${node.fontFamily} → ${font.family} ${font.style}`);
      return font;
    };
    const images = new Map();
    for (const [id, asset] of Object.entries(data.assets || {})) { if (!asset.bytes) continue; images.set(id, figma.createImage(new Uint8Array(asset.bytes))); }
    let x = Math.max(0, ...figma.currentPage.children.map(n => n.x + n.width)) + 120;
    for (const [index, board] of data.boards.entries()) {
      const frame = figma.createFrame(); created.push(frame); frame.name = `${index + 1}. ${board.name}`; frame.resize(board.width, board.height); frame.x = x; frame.y = 0; frame.fills = []; frame.clipsContent = false;
      frame.setPluginData('studioBoardId', board.id); frame.setPluginData('designSpecName', data.tokens?.name || '');
      for (const source of board.nodes) {
        let node;
        if (source.type === 'RECTANGLE' || source.type === 'ELLIPSE') { node = source.type === 'ELLIPSE' ? figma.createEllipse() : figma.createRectangle(); frame.appendChild(node); node.fills = [{ type: 'SOLID', color: hexColor(source.color) }]; }
        if (source.type === 'VECTOR') {
          node = figma.createVector(); frame.appendChild(node); node.vectorPaths = source.vectorPaths.map(p => ({data:p.data,windingRule:p.windingRule}));
          node.fills = source.filled ? [{type:'SOLID',color:hexColor(source.color)}] : [];
          node.strokes = source.strokeWidth ? [{type:'SOLID',color:hexColor(source.color)}] : []; node.strokeWeight = source.strokeWidth;
        }
        if (source.type === 'IMAGE') {
          node = figma.createRectangle(); frame.appendChild(node); node.fills = [{ type: 'IMAGE', imageHash: images.get(source.assetId).hash, scaleMode: 'FIT' }]; node.setPluginData('sourceSHA256', source.hash); node.setPluginData('sourceAssetId', source.assetId);
        }
        if (source.type === 'TEXT') {
          const font = await findFont(source); node = figma.createText(); frame.appendChild(node); node.fontName = font; node.characters = source.characters; node.fontSize = source.fontSize;
          node.lineHeight = { unit: 'PIXELS', value: source.fontSize * source.lineHeight }; node.letterSpacing = { unit: 'PIXELS', value: source.letterSpacing || 0 };
          node.textAlignHorizontal = source.align === 'center' ? 'CENTER' : source.align === 'right' ? 'RIGHT' : 'LEFT'; node.fills = [{ type: 'SOLID', color: hexColor(source.color) }];
          node.resize(source.width, Math.max(1, source.height)); node.textAutoResize = 'HEIGHT';
          if (Math.abs(node.height - source.height) > 4) notes.push(`${board.name} / ${source.name}：Figma 文字高度 ${Math.round(node.height)}px，浏览器 ${Math.round(source.height)}px，请复核换行与字体。`);
          node.setPluginData('originalCharacters', source.characters);
        }
        frame.appendChild(node); node.name = source.name; node.x = source.x; node.y = source.y;
        if (source.type !== 'TEXT' && source.type !== 'VECTOR') node.resize(source.width, source.height);
        node.visible = source.visible !== false; node.locked = source.locked === true;
        node.setPluginData('studioNodeId', source.id);
      }
      x += board.width + 120;
    }
    figma.currentPage.selection = created; figma.viewport.scrollAndZoomIntoView(created);
    if (reconstruction) notes.push('照片与复杂细节仍为位图。原图是隐藏锁定层；需要对照时请在图层面板显示。字体为估计值，请核对原文、字体、换行和清底区域。');
    figma.ui.postMessage({ type: 'result', ok: true, count: created.length, notes: [...new Set(notes)], textCount: created.reduce((n, f) => n + f.children.filter(c => c.type === 'TEXT').length, 0), shapeCount: created.reduce((n, f) => n + f.children.filter(c => ['VECTOR','ELLIPSE','RECTANGLE'].includes(c.type) && !c.fills?.some(p=>p.type==='IMAGE')).length,0) });
    figma.notify(`已导入 ${created.length} 个画板；请查看字体与排版核对结果。`);
  } catch (error) {
    for (const frame of created) if (!frame.removed) frame.remove();
    figma.ui.postMessage({ type: 'result', ok: false, message: error.message || String(error) });
  } finally { importing = false; }
};

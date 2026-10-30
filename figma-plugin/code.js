/* Native Figma importer. No network or provider keys. */
figma.showUI(__html__, { width: 480, height: 530, themeColors: true });
const hexColor = hex => { if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('无效图层颜色'); return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 }; };
let importing = false;
figma.ui.onmessage = async message => {
  if (message.type !== 'import' || importing) return;
  importing = true; const created = [], notes = [];
  try {
    const data = message.data;
    if (data.schema !== 'studio-standard/2' || !Array.isArray(data.boards) || !data.boards.length || data.boards.length > 30) throw new Error('不支持的文件格式或画板数量。请使用工作台导出的 figma-import.json。');
    for (const board of data.boards) {
      if (!Number.isFinite(board.width) || !Number.isFinite(board.height) || board.width < 320 || board.height < 320 || board.width > 4096 || board.height > 4096 || !Array.isArray(board.nodes) || board.nodes.length > 100) throw new Error('画板数据不合法。');
      for (const node of board.nodes) {
        if (!['RECTANGLE', 'TEXT', 'IMAGE'].includes(node.type)) throw new Error('包含未支持的图层类型。');
        if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0 || node.x < 0 || node.y < 0 || node.x + node.width > board.width + 1 || node.y + node.height > board.height + 1) throw new Error('存在无效或越界图层。');
        if (node.type === 'IMAGE' && !data.assets[node.assetId]?.bytes?.length) throw new Error('缺少图片二进制数据。');
        if (node.type === 'TEXT' && (typeof node.characters !== 'string' || node.characters.length > 50000)) throw new Error('文字图层不合法。');
      }
    }
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
        if (source.type === 'RECTANGLE') { node = figma.createRectangle(); frame.appendChild(node); node.fills = [{ type: 'SOLID', color: hexColor(source.color) }]; }
        if (source.type === 'IMAGE') {
          node = figma.createRectangle(); frame.appendChild(node); node.fills = [{ type: 'IMAGE', imageHash: images.get(source.assetId).hash, scaleMode: 'FIT' }]; node.setPluginData('sourceSHA256', source.hash); node.setPluginData('sourceAssetId', source.assetId);
        }
        if (source.type === 'TEXT') {
          const font = await findFont(source); node = figma.createText(); frame.appendChild(node); node.fontName = font; node.characters = source.characters; node.fontSize = source.fontSize;
          node.lineHeight = { unit: 'PIXELS', value: source.fontSize * source.lineHeight }; node.letterSpacing = { unit: 'PIXELS', value: source.letterSpacing || 0 };
          node.textAlignHorizontal = source.align === 'center' ? 'CENTER' : 'LEFT'; node.fills = [{ type: 'SOLID', color: hexColor(source.color) }];
          node.resize(source.width, Math.max(1, source.height)); node.textAutoResize = 'HEIGHT';
          if (Math.abs(node.height - source.height) > 4) notes.push(`${board.name} / ${source.name}：Figma 文字高度 ${Math.round(node.height)}px，浏览器 ${Math.round(source.height)}px，请复核换行与字体。`);
          node.setPluginData('originalCharacters', source.characters);
        }
        frame.appendChild(node); node.name = source.name; node.x = source.x; node.y = source.y;
        if (source.type !== 'TEXT') node.resize(source.width, source.height);
        node.setPluginData('studioNodeId', source.id);
      }
      x += board.width + 120;
    }
    figma.currentPage.selection = created; figma.viewport.scrollAndZoomIntoView(created);
    figma.ui.postMessage({ type: 'result', ok: true, count: created.length, notes: [...new Set(notes)], textCount: created.reduce((n, f) => n + f.children.filter(c => c.type === 'TEXT').length, 0) });
    figma.notify(`已导入 ${created.length} 个画板；请查看字体与排版核对结果。`);
  } catch (error) {
    for (const frame of created) if (!frame.removed) frame.remove();
    figma.ui.postMessage({ type: 'result', ok: false, message: error.message || String(error) });
  } finally { importing = false; }
};

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconstruct } from './lib/reconstruction-api.js';

const root = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.STUDIO_PORT || process.env.PORT || 4174);
const config = { baseUrl: process.env.STUDIO_VISION_BASE_URL || 'https://api.openai.com/v1', model: process.env.STUDIO_VISION_MODEL || '', key: process.env.STUDIO_VISION_KEY || process.env.OPENAI_API_KEY || '', protocol: process.env.STUDIO_VISION_PROTOCOL || 'responses' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png' };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 90 * 1024 * 1024) throw new Error('请求超过 90MB，请减少图片大小。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求不是有效 JSON。'); }
}
export const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      const host = req.headers.host, origins = new Set([`http://${host}`, `https://${host}`, process.env.STUDIO_PUBLIC_ORIGIN?.replace(/\/$/, '')].filter(Boolean));
      if (req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, { error: '仅允许当前工作台来源调用接口。' });
      if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, { version: '0.5.0', workflow: 'image-to-figma', vision: { configured: Boolean(config.key && config.model), model: config.model, baseUrl: config.baseUrl, protocol: config.protocol } });
      if (['/api/config', '/api/vision', '/api/ocr'].includes(pathname)) return json(res, 410, { error: '旧规范分析接口已退役，请使用图片分层工作台。' });
      if (pathname !== '/api/reconstruct') return json(res, 404, { error: 'Not found' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '请使用 JSON 请求。' });
      return json(res, 200, await reconstruct(await body(req), config));
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    const decoded = decodeURIComponent(pathname);
    const allowed = ['/', '/index.html', '/app.js', '/styles.css', '/SOP.md', '/README.md'].includes(decoded) || decoded.startsWith('/lib/') || decoded.startsWith('/figma-plugin/') || decoded.startsWith('/vendor/');
    if (!allowed) { res.writeHead(404); return res.end('Not found'); }
    const path = decoded.startsWith('/vendor/') ? resolve(root, 'node_modules', decoded.slice('/vendor/'.length)) : resolve(root, decoded === '/' ? 'index.html' : decoded.slice(1));
    const permittedRoot = decoded.startsWith('/vendor/') ? resolve(root, 'node_modules') : root;
    if (relative(permittedRoot, path).startsWith('..') || decoded.includes('\0')) { res.writeHead(403); return res.end('Forbidden'); }
    let content; try { content = await readFile(path); } catch { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) { json(res, 400, { error: error.message || '处理失败。' }); }
});
server.listen(port, process.env.STUDIO_HOST || '127.0.0.1', () => console.log(`Studio Layers v0.5 · http://${process.env.STUDIO_HOST || '127.0.0.1'}:${port}`));
function shutdown() { server.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

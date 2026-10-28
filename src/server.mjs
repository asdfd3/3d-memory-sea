// 零依赖的本地服务：静态页面 + 两个接口。
//   GET  /api/scene    → 场景 JSON（点、边、统计）
//   POST /api/rebuild  → 用当前数据重建一次
//   GET  /api/health   → 健康检查
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSceneService } from './scene-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const dataFile = process.env.DATA ? path.resolve(process.env.DATA) : path.join(root, 'data', 'demo.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[memory-sea] 读不到数据文件 ${file}：${error.message}`);
    return {};
  }
}

const service = createSceneService({ data: readJson(dataFile) });

function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/scene') {
    const focusIds = (url.searchParams.get('focus') || '').split(',').filter(Boolean);
    const limit = Number(url.searchParams.get('limit') || 0);
    return json(res, service.scene({ focusIds, limit }));
  }
  if (url.pathname === '/api/rebuild' && req.method === 'POST') {
    return json(res, service.rebuild());
  }
  if (url.pathname === '/api/health') {
    return json(res, { ok: true, points: service.points.length });
  }

  const rel = url.pathname === '/' ? 'public/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`[memory-sea] http://${host}:${port}`);
  console.log(`[memory-sea] 数据：${dataFile}（${service.points.length} 个点）`);
});

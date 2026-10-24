'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sendText } = require('./body');

const MIME_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
  }),
);

async function statFile(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

function createStaticHandler({ clientDir, log, logError }) {
  async function serveStatic(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendText(res, 400, '400 Bad Request');
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let filePath = path.resolve(clientDir, relative);

    // 目录穿越防护：解析后必须仍在 client/ 内
    if (filePath !== clientDir && !filePath.startsWith(clientDir + path.sep)) {
      log('HTTP', `拒绝越界路径: ${pathname}`);
      sendText(res, 403, '403 Forbidden');
      return;
    }

    let stat = await statFile(filePath);
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await statFile(filePath);
    }

    if (!stat || !stat.isFile()) {
      sendText(res, 404, '404 Not Found');
      return;
    }

    const contentType =
      MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      logError('HTTP', `读取静态文件失败 ${filePath}: ${err.message}`);
      res.destroy(err);
    });
    stream.pipe(res);
  }

  return serveStatic;
}

module.exports = { createStaticHandler, MIME_TYPES, statFile };

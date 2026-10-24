'use strict';

const http = require('node:http');
const https = require('node:https');
const { sendJson } = require('./body');

function createHttpServer({ tls } = {}) {
  if (tls && tls.key && tls.cert) {
    return { server: https.createServer({ key: tls.key, cert: tls.cert }), secure: true };
  }
  return { server: http.createServer(), secure: false };
}

/**
 * 路由：/api/*、/status、/metrics 交给 api；/upload、/play 需要管理员；
 * 其余走静态文件。/host 映射到 host.html。
 */
function createRequestHandler({ api, auth, upload, serveStatic, log, logError }) {
  return function handleRequest(req, res) {
    const startedAt = Date.now();
    let pathname = '/';

    try {
      pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      pathname = '/';
    }

    res.on('finish', () => {
      log('HTTP', `${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });

    const run = (promise, scope, fallbackMessage) => {
      promise.catch((err) => {
        logError(scope, `未捕获异常: ${err.stack || err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: fallbackMessage });
        else res.destroy();
      });
    };

    try {
      if (
        pathname.startsWith('/api/') ||
        pathname === '/status' ||
        pathname === '/metrics'
      ) {
        run(api.handle(req, res, pathname), 'API', '服务器错误');
        return;
      }

      if (pathname === '/upload') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
          return;
        }
        if (!auth.requireAdmin(req, res)) return;
        run(upload(req, res), 'UPLOAD', '上传处理失败');
        return;
      }

      if (pathname === '/play') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
          return;
        }
        if (!auth.requireAdmin(req, res)) return;
        run(api.handlePlay(req, res), 'PLAY', '播放请求处理失败');
        return;
      }

      if (pathname === '/host') {
        req.url = '/host.html';
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: `不支持的方法 ${req.method}` }, { Allow: 'GET, HEAD' });
        return;
      }

      run(serveStatic(req, res), 'HTTP', '静态文件处理失败');
    } catch (err) {
      logError('HTTP', `请求处理异常: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      else res.destroy();
    }
  };
}

module.exports = { createHttpServer, createRequestHandler };

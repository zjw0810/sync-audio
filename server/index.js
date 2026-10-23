'use strict';

/**
 * sync-audio · 模块 1：HTTP + WebSocket 骨架
 *
 * 职责（仅本模块）：
 *   1. 用 Node 内置 http 起服务，监听 0.0.0.0:3000，托管 client/ 静态文件；
 *   2. POST /upload 接收 multipart/form-data（字段名 file），落盘到 uploads/；
 *   3. 在同一个 http server 上挂载 ws 的 WebSocketServer，分配递增连接 ID 并维护列表；
 *   4. 打日志。解码与广播在后续模块实现。
 *
 * 约束：不使用 Express；不使用任何 multipart 第三方解析库（手写流式解析，边收边写盘）。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { ensureFfmpeg, ensureLoopbackHelper, readDefaultRenderFormat } = require('./audio/decoder');
const { Broadcaster } = require('./audio/broadcaster');
const { RtcHub } = require('./rtc');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const HOST = '0.0.0.0';
const PORT = 3000;

const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT_DIR, 'client');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 单个上传上限 300MB
const MAX_PART_HEADER_BYTES = 16 * 1024;

/** 由 start() 里的 ensureFfmpeg() 填充，供 /play 判断能否解码。 */
let ffmpegStatus = { ok: false, error: 'ffmpeg 尚未初始化' };

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function timestamp(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function log(scope, ...args) {
  console.log(`[${timestamp()}] [${scope}]`, ...args);
}

function logError(scope, ...args) {
  console.error(`[${timestamp()}] [${scope}]`, ...args);
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

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
  let filePath = path.resolve(CLIENT_DIR, relative);

  // 目录穿越防护：解析后必须仍在 client/ 内
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + path.sep)) {
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

// ---------------------------------------------------------------------------
// multipart/form-data 解析（流式，边收边写盘，不把整个文件读进内存）
// ---------------------------------------------------------------------------

function parsePartHeaders(rawHeaders) {
  const headers = Object.create(null);
  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    headers[name] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value) {
  const result = Object.create(null);
  if (!value) return result;

  const pattern = /([^\s;=]+)\s*=\s*(?:"([^"]*)"|([^;]*))/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const key = match[1].toLowerCase();
    const raw = match[2] !== undefined ? match[2] : (match[3] || '').trim();
    result[key] = raw;
  }

  // RFC 5987: filename*=UTF-8''%E6%B5%8B%E8%AF%95.mp3
  if (result['filename*']) {
    const encoded = result['filename*'];
    const apostrophe = encoded.indexOf("''");
    if (apostrophe !== -1) {
      try {
        result.filename = decodeURIComponent(encoded.slice(apostrophe + 2));
      } catch {
        result.filename = encoded.slice(apostrophe + 2);
      }
    }
  }

  return result;
}

/**
 * 极简流式 multipart 解析器。
 * 通过给缓冲区加一个前置 CRLF，让「首个边界」和「后续边界」形状一致：
 *   \r\n--boundary\r\n<headers>\r\n\r\n<body>\r\n--boundary--\r\n
 * 每次只保留「可能是边界前缀」的尾部，因此内存占用与文件大小无关。
 */
class MultipartParser {
  constructor(boundary, handlers) {
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
    this.buf = Buffer.from('\r\n');
    this.state = 'preamble';
    this.headers = null;
    this.handlers = handlers;
    this.finished = false;
  }

  feed(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  drain() {
    for (;;) {
      if (this.state === 'preamble') {
        const at = this.buf.indexOf(this.delimiter);
        if (at === -1) {
          const keep = this.delimiter.length - 1;
          if (this.buf.length > keep) {
            this.buf = Buffer.from(this.buf.subarray(this.buf.length - keep));
          }
          return;
        }
        this.buf = this.buf.subarray(at + this.delimiter.length);
        this.state = 'afterBoundary';
        continue;
      }

      if (this.state === 'afterBoundary') {
        if (this.buf.length < 2) return;
        const marker = this.buf.subarray(0, 2).toString('latin1');
        if (marker === '--') {
          this.state = 'epilogue';
          this.finished = true;
          this.buf = Buffer.alloc(0);
          this.handlers.onEnd?.();
          return;
        }
        if (marker === '\r\n') {
          this.buf = this.buf.subarray(2);
          this.state = 'headers';
          continue;
        }
        throw new HttpError(400, 'multipart 格式错误：边界后缺少 CRLF');
      }

      if (this.state === 'headers') {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end === -1) {
          if (this.buf.length > MAX_PART_HEADER_BYTES) {
            throw new HttpError(400, 'multipart 分段头过长');
          }
          return;
        }
        this.headers = parsePartHeaders(this.buf.subarray(0, end).toString('utf8'));
        this.buf = this.buf.subarray(end + 4);
        this.state = 'body';
        this.handlers.onPartBegin?.(this.headers);
        continue;
      }

      if (this.state === 'body') {
        const at = this.buf.indexOf(this.delimiter);
        if (at !== -1) {
          if (at > 0) this.handlers.onPartData?.(this.buf.subarray(0, at));
          this.buf = this.buf.subarray(at + this.delimiter.length);
          this.state = 'afterBoundary';
          this.handlers.onPartEnd?.();
          continue;
        }
        const safeLength = this.buf.length - (this.delimiter.length - 1);
        if (safeLength > 0) {
          this.handlers.onPartData?.(this.buf.subarray(0, safeLength));
          this.buf = this.buf.subarray(safeLength);
        }
        return;
      }

      // epilogue：忽略结束边界之后的填充
      this.buf = Buffer.alloc(0);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 文件名处理
// ---------------------------------------------------------------------------

function sanitizeFilename(input) {
  const normalized = String(input).replace(/\\/g, '/');
  const base = path.basename(normalized);
  let name = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, ''); // Windows 不允许以点或空格结尾

  if (!name) name = `upload-${Date.now()}.mp3`;

  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }

  return name;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFilename(baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length) || 'upload';
  let candidate = baseName;
  let index = 1;
  while (await fileExists(path.join(UPLOAD_DIR, candidate))) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// POST /upload
// ---------------------------------------------------------------------------

async function finalizeUpload(entry) {
  if (entry.bytes === 0) {
    await fsp.rm(entry.tmpPath, { force: true }).catch(() => {});
    throw new HttpError(400, '上传的文件为空');
  }

  const baseName = sanitizeFilename(entry.filename);
  const finalName = await uniqueFilename(baseName);
  await fsp.rename(entry.tmpPath, path.join(UPLOAD_DIR, finalName));
  return { filename: finalName, bytes: entry.bytes };
}

function receiveFileUpload(req, boundary) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let part = null;
    let sawFileField = false;
    let totalBytes = 0;

    const cleanupPart = () => {
      if (!part) return;
      const pending = part;
      part = null;
      pending.stream.destroy();
      fsp.rm(pending.tmpPath, { force: true }).catch(() => {});
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupPart();
      reject(err);
    };

    const parser = new MultipartParser(boundary, {
      onPartBegin(headers) {
        if (sawFileField) return;
        const disposition = parseContentDisposition(headers['content-disposition']);
        if (disposition.name !== 'file' || !disposition.filename) return;

        sawFileField = true;
        const tmpPath = path.join(UPLOAD_DIR, `.upload-${crypto.randomUUID()}.part`);
        const stream = fs.createWriteStream(tmpPath);
        stream.on('error', (err) => fail(err));
        part = { stream, tmpPath, bytes: 0, filename: disposition.filename };
      },

      onPartData(chunk) {
        if (!part || !part.stream.writable) return;

        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          fail(new HttpError(413, `文件超过上限 ${formatBytes(MAX_UPLOAD_BYTES)}`));
          return;
        }

        part.bytes += chunk.length;
        if (!part.stream.write(chunk)) {
          req.pause();
          part.stream.once('drain', () => req.resume());
        }
      },

      onPartEnd() {
        if (!part) return;
        const finishedPart = part;
        part = null;
        finishedPart.stream.end(() => {
          finalizeUpload(finishedPart)
            .then((saved) => {
              if (settled) return;
              settled = true;
              resolve(saved);
            })
            .catch((err) => fail(err));
        });
      },

      onEnd() {
        if (settled) return;
        if (!sawFileField) {
          settled = true;
          resolve(null);
        }
        // 若文件分段已结束，结果由 finalizeUpload 收尾
      },
    });

    req.on('data', (chunk) => {
      if (settled) return;
      try {
        parser.feed(chunk);
      } catch (err) {
        fail(err instanceof HttpError ? err : new HttpError(400, err.message));
      }
    });

    req.on('end', () => {
      if (settled) return;
      if (!parser.finished) fail(new HttpError(400, '上传数据不完整'));
    });

    req.on('aborted', () => fail(new HttpError(499, '客户端中断了上传')));
    req.on('error', (err) => fail(err));
  });
}

async function handleUpload(req, res) {
  const startedAt = Date.now();
  const contentType = req.headers['content-type'] || '';
  const match = /^multipart\/form-data\b[^;]*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    contentType,
  );

  if (!match) {
    sendJson(res, 400, { error: '需要 multipart/form-data 且带 boundary' });
    return;
  }

  const boundary = (match[1] || match[2] || '').trim();
  if (!boundary) {
    sendJson(res, 400, { error: 'multipart boundary 为空' });
    return;
  }

  try {
    const saved = await receiveFileUpload(req, boundary);
    if (!saved) {
      sendJson(res, 400, { error: 'multipart 中未找到字段 file' });
      return;
    }
    log(
      'UPLOAD',
      `已保存 uploads/${saved.filename} (${formatBytes(saved.bytes)}, ${Date.now() - startedAt}ms)`,
    );
    sendJson(res, 200, { filename: saved.filename });
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const statusCode = err instanceof HttpError ? err.statusCode : 500;
    logError('UPLOAD', `失败: ${err.message}`);
    sendJson(res, statusCode, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /play
// ---------------------------------------------------------------------------

const MAX_JSON_BODY_BYTES = 64 * 1024;

function readJsonBody(req, limit = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(reject, new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      if (size === 0) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(reject, new HttpError(400, 'JSON 解析失败'));
      }
    });

    req.on('error', (err) => finish(reject, err));
  });
}

/** 校验 filename 只能是 uploads/ 下的文件名，返回绝对路径。 */
function resolveUploadedFile(filename) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new HttpError(400, '缺少 filename');
  }
  const normalized = filename.replace(/\\/g, '/');
  const base = path.basename(normalized);
  if (base !== normalized || base.startsWith('.')) {
    throw new HttpError(400, '非法文件名：只允许 uploads 目录下的文件名');
  }
  const filePath = path.join(UPLOAD_DIR, base);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
    throw new HttpError(400, '非法文件名');
  }
  return { name: base, filePath };
}

async function handlePlay(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const statusCode = err instanceof HttpError ? err.statusCode : 400;
    sendJson(res, statusCode, { error: err.message });
    return;
  }

  let target;
  try {
    target = resolveUploadedFile(body.filename);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target.filePath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    sendJson(res, 404, { error: `文件不存在: ${target.name}` });
    return;
  }

  if (!ffmpegStatus.ok) {
    sendJson(res, 500, { error: ffmpegStatus.error });
    return;
  }

  const requestedAt = Date.now();
  try {
    await broadcaster.play(target.filePath, target.name);
    log(
      'PLAY',
      `开始播放 ${target.name}（${formatBytes(stat.size)}），首块 ${Date.now() - requestedAt}ms 内送出，在线客户端 ${wss.clients.size} 个`,
    );
    sendJson(res, 200, { playing: true, filename: target.name });
  } catch (err) {
    logError('PLAY', `启动广播失败: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
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

  try {
    if (pathname === '/upload') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }
      handleUpload(req, res).catch((err) => {
        logError('UPLOAD', `未捕获异常: ${err.stack || err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: '上传处理失败' });
        else res.destroy();
      });
      return;
    }

    if (pathname === '/play') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }
      handlePlay(req, res).catch((err) => {
        logError('PLAY', `未捕获异常: ${err.stack || err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: '播放请求处理失败' });
        else res.destroy();
      });
      return;
    }

    if (pathname === '/status') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '仅支持 GET' }, { Allow: 'GET' });
        return;
      }
      sendJson(res, 200, {
        sharing: broadcaster.playing,
        kind: broadcaster.sourceKind || null,
        device: broadcaster.deviceName || null,
        clients: clients.size,
        level: broadcaster.lastPeak || 0,
        ffmpeg: ffmpegStatus.ok,
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: `不支持的方法 ${req.method}` }, { Allow: 'GET, HEAD' });
      return;
    }

    serveStatic(req, res).catch((err) => {
      logError('HTTP', `静态文件处理失败: ${err.message}`);
      if (!res.headersSent) sendText(res, 500, '500 Internal Server Error');
      else res.destroy();
    });
  } catch (err) {
    logError('HTTP', `请求处理异常: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  }
});

// ---------------------------------------------------------------------------
// WebSocket 连接管理（解码与广播在后续模块实现）
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

let nextClientId = 1;
const clients = new Map(); // id -> WebSocket

const broadcaster = new Broadcaster(wss, {
  log: (scope, ...args) => log(scope, ...args),
  logError: (scope, ...args) => logError(scope, ...args),
});

/** WebRTC/Opus 出口：公网/高抖动客户端走这条，局域网仍走 PCM over WS */
const rtcHub = new RtcHub({
  log: (scope, ...args) => log(scope, ...args),
  logError: (scope, ...args) => logError(scope, ...args),
});

broadcaster.on('pcm', (block) => rtcHub.pushBlock(block));

let shuttingDown = false;
let shareRetryTimer = null;
let shareAttempts = 0;
let deviceWatchTimer = null;

/** 每 5 秒检查默认播放设备是否被换掉；换了就重新采集，否则会一直采一个没有声音的旧设备 */
async function watchCaptureDevice() {
  if (shuttingDown) return;
  deviceWatchTimer = setTimeout(watchCaptureDevice, 5000);
  if (typeof deviceWatchTimer.unref === 'function') deviceWatchTimer.unref();

  if (!broadcaster.playing || broadcaster.sourceKind !== 'system') return;

  try {
    const info = readDefaultRenderFormat(ensureLoopbackHelper());
    if (info.name && broadcaster.deviceName && info.name !== broadcaster.deviceName) {
      log(
        'SHARE',
        `默认播放设备已切换：「${broadcaster.deviceName}」→「${info.name}」，重新采集`,
      );
      await broadcaster.playSystem();
    }
  } catch {
    /* 设备枚举偶尔失败，下一轮再试 */
  }
}

/**
 * 共享本机默认播放设备的声音。
 * 失败（没有音频设备、编译失败）时按退避重试，不影响文件播放和 HTTP 服务。
 */
async function startSystemShare(reason = 'startup') {
  if (shuttingDown) return;
  if (shareRetryTimer) {
    clearTimeout(shareRetryTimer);
    shareRetryTimer = null;
  }

  try {
    await broadcaster.playSystem();
    shareAttempts = 0;
    log('SHARE', `已开始共享本机声音（${reason}）`);
  } catch (err) {
    shareAttempts += 1;
    const delay = Math.min(60000, 3000 * 2 ** Math.min(shareAttempts - 1, 4));
    logError('SHARE', `本机声音共享启动失败: ${err.message}（${Math.round(delay / 1000)} 秒后重试）`);
    if (!shuttingDown) {
      shareRetryTimer = setTimeout(() => startSystemShare('retry'), delay);
      if (typeof shareRetryTimer.unref === 'function') shareRetryTimer.unref();
    }
  }
}

broadcaster.on('end', (info) => {
  if (info.kind === 'system') {
    if (info.error) logError('SHARE', `本机声音采集中断: ${info.error.message}`);
    if (shuttingDown) return;
    shareRetryTimer = setTimeout(() => startSystemShare('restart'), 2000);
    if (typeof shareRetryTimer.unref === 'function') shareRetryTimer.unref();
    return;
  }

  if (info.error) logError('PLAY', `${info.filename} 播放失败: ${info.error.message}`);
  else log('PLAY', `${info.filename} 播放完成，共 ${info.seq} 块`);

  // 文件播完后回到共享本机声音
  if (!shuttingDown) {
    shareRetryTimer = setTimeout(() => startSystemShare('after-file'), 300);
    if (typeof shareRetryTimer.unref === 'function') shareRetryTimer.unref();
  }
});

wss.on('connection', (socket, req) => {
  const id = nextClientId++;
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  const remotePort = req.socket.remotePort || 0;
  const remote = `${remoteAddress}:${remotePort}`;

  clients.set(id, socket);
  log('WS', `#${id} 已连接 ${remote}，在线 ${clients.size} 个`);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log('WS', `#${id} 收到二进制帧 ${data.length} bytes（服务端不接受上行音频，忽略）`);
      return;
    }
    const text = data.toString('utf8');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      log('WS', `#${id} 收到非 JSON 文本: ${truncate(text)}`);
      return;
    }

    if (payload.type === 'rtc_start' || payload.type === 'rtc_answer' || payload.type === 'rtc_ice') {
      rtcHub.handleMessage(id, socket, payload).catch((err) => {
        logError('RTC', `#${id} 处理失败: ${err.message}`);
      });
      return;
    }

    // NTP 简化握手：立刻盖 t2 并原样带回 t1
    if (payload.type === 'sync' && typeof payload.t1 === 'number') {
      if (!socket.syncStarted) {
        socket.syncStarted = true;
        log('WS', `#${id} 开始 NTP 握手`);
      }
      socket.send(JSON.stringify({ type: 'sync_reply', t1: payload.t1, t2: Date.now() }));
      return;
    }

    log('WS', `#${id} 收到 JSON: ${truncate(JSON.stringify(payload))}`);
  });

  socket.on('close', (code, reason) => {
    clients.delete(id);
    rtcHub.closePeer(id);
    const detail = reason && reason.length ? `, reason=${reason.toString('utf8')}` : '';
    log('WS', `#${id} 已断开 (code=${code}${detail})，在线 ${clients.size} 个`);
  });

  socket.on('error', (err) => {
    logError('WS', `#${id} 连接错误: ${err.message}`);
  });
});

wss.on('error', (err) => {
  logError('WS', `WebSocketServer 错误: ${err.message}`);
});

// ---------------------------------------------------------------------------
// 心跳：每 2 秒向所有客户端广播服务端时间（同一 tick 内共用一个 Date.now()）
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 2000;

const heartbeatTimer = setInterval(() => {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: 'heartbeat', serverTime: Date.now() });
  for (const socket of clients.values()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try {
      socket.send(payload);
    } catch (err) {
      logError('WS', `heartbeat 发送失败: ${err.message}`);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 启动 / 关闭
// ---------------------------------------------------------------------------

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push({ name, address: entry.address });
      }
    }
  }
  return result;
}

function printBanner() {
  log('SYS', 'sync-audio 服务端已启动（本机声音共享 + 时钟同步 + PCM 广播）');
  log('SYS', `监听地址: http://${HOST}:${PORT}`);
  log('SYS', `本机访问: http://localhost:${PORT}`);
  for (const { name, address } of lanAddresses()) {
    log('SYS', `局域网访问 (${name}): http://${address}:${PORT}`);
  }
  log('SYS', `静态目录: ${CLIENT_DIR}`);
  log('SYS', `上传目录: ${UPLOAD_DIR}`);
}

async function start() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(CLIENT_DIR, { recursive: true });

  ffmpegStatus = ensureFfmpeg();
  if (ffmpegStatus.ok) {
    log(
      'SYS',
      `ffmpeg 已就绪: ${ffmpegStatus.version}${ffmpegStatus.note ? `（${ffmpegStatus.note}）` : ''}`,
    );
  } else {
    logError('SYS', `警告：${ffmpegStatus.error}`);
  }

  const indexFile = path.join(CLIENT_DIR, 'index.html');
  if (!(await fileExists(indexFile))) {
    logError('SYS', `警告：缺少 ${indexFile}，访问 / 会返回 404`);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logError('SYS', `端口 ${PORT} 已被占用，请先结束占用进程再启动`);
    } else {
      logError('SYS', `HTTP 服务器错误: ${err.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    printBanner();
    // 默认就把本机正在播放的声音共享出去；没有音频设备时会在后台退避重试
    startSystemShare('startup');
    watchCaptureDevice();
  });
}

function shutdown(signal) {
  log('SYS', `收到 ${signal}，正在关闭…`);
  shuttingDown = true;
  if (shareRetryTimer) {
    clearTimeout(shareRetryTimer);
    shareRetryTimer = null;
  }
  if (deviceWatchTimer) {
    clearTimeout(deviceWatchTimer);
    deviceWatchTimer = null;
  }
  clearInterval(heartbeatTimer);
  rtcHub.closeAll();
  broadcaster.stop('服务端关闭').catch(() => {});
  for (const socket of clients.values()) {
    try {
      socket.close(1001, 'server shutting down');
    } catch {
      /* 忽略关闭异常 */
    }
  }
  wss.close();
  server.close(() => {
    log('SYS', '服务已停止');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  logError('SYS', `启动失败: ${err.stack || err.message}`);
  process.exit(1);
});

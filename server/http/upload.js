'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError, sendJson } = require('./body');

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
 * 给缓冲区加一个前置 CRLF，让「首个边界」和「后续边界」形状一致：
 *   \r\n--boundary\r\n<headers>\r\n\r\n<body>\r\n--boundary--\r\n
 * 每次只保留「可能是边界前缀」的尾部，因此内存占用与文件大小无关。
 */
class MultipartParser {
  constructor(boundary, handlers, { maxPartHeaderBytes = 16 * 1024 } = {}) {
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
    this.buf = Buffer.from('\r\n');
    this.state = 'preamble';
    this.headers = null;
    this.handlers = handlers;
    this.finished = false;
    this.maxPartHeaderBytes = maxPartHeaderBytes;
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
          if (this.buf.length > this.maxPartHeaderBytes) {
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

function sanitizeFilename(input) {
  const normalized = String(input).replace(/\\/g, '/');
  const base = path.basename(normalized);
  let name = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

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

function createUploadHandler({ uploadDir, maxUploadBytes, maxPartHeaderBytes, log, logError }) {
  async function uniqueFilename(baseName) {
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length) || 'upload';
    let candidate = baseName;
    let index = 1;
    while (await fileExists(path.join(uploadDir, candidate))) {
      candidate = `${stem}-${index}${ext}`;
      index += 1;
    }
    return candidate;
  }

  async function finalizeUpload(entry) {
    if (entry.bytes === 0) {
      await fsp.rm(entry.tmpPath, { force: true }).catch(() => {});
      throw new HttpError(400, '上传的文件为空');
    }

    const baseName = sanitizeFilename(entry.filename);
    const finalName = await uniqueFilename(baseName);
    await fsp.rename(entry.tmpPath, path.join(uploadDir, finalName));
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

      const parser = new MultipartParser(
        boundary,
        {
          onPartBegin(headers) {
            if (sawFileField) return;
            const disposition = parseContentDisposition(headers['content-disposition']);
            if (disposition.name !== 'file' || !disposition.filename) return;

            sawFileField = true;
            const tmpPath = path.join(uploadDir, `.upload-${crypto.randomUUID()}.part`);
            const stream = fs.createWriteStream(tmpPath);
            stream.on('error', (err) => fail(err));
            part = { stream, tmpPath, bytes: 0, filename: disposition.filename };
          },

          onPartData(chunk) {
            if (!part || !part.stream.writable) return;

            totalBytes += chunk.length;
            if (totalBytes > maxUploadBytes) {
              fail(new HttpError(413, '文件超过上传上限'));
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
          },
        },
        { maxPartHeaderBytes },
      );

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

  return async function handleUpload(req, res) {
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
      const kb = (saved.bytes / 1024).toFixed(0);
      log('UPLOAD', `已保存 uploads/${saved.filename} (${kb} KB, ${Date.now() - startedAt}ms)`);
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
  };
}

module.exports = {
  createUploadHandler,
  MultipartParser,
  parsePartHeaders,
  parseContentDisposition,
  sanitizeFilename,
};

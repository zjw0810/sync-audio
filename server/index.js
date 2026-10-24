'use strict';

/**
 * 装配层：只负责创建依赖、接线、启动和关闭。
 * 具体职责见：
 *   auth.js      密码（scrypt）/会话/限流
 *   http/        HTTP 路由、静态文件、上传、API
 *   ws.js        WebSocket 鉴权、NTP、心跳、统计
 *   player.js    音源/暂停/曲目
 *   capture.js   本机声音采集生命周期
 *   audio/       PCM 解码与广播
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const config = require('./config');
const { log, logError } = require('./logger');
const { Auth } = require('./auth');
const { Metrics } = require('./metrics');
const { Broadcaster } = require('./audio/broadcaster');
const { RtcHub } = require('./rtc');
const { Player } = require('./player');
const { SystemShare } = require('./capture');
const { createWebSocket } = require('./ws');
const { createApi } = require('./http/api');
const { createUploadHandler } = require('./http/upload');
const { createStaticHandler } = require('./http/static');
const { createHttpServer, createRequestHandler } = require('./http/server');
const { ensureFfmpeg } = require('./audio/decoder');

let ffmpegStatus = { ok: false, error: 'ffmpeg 尚未初始化' };
let shuttingDown = false;

function lanAddresses() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push({ name, address: entry.address });
      }
    }
  }
  return result;
}

function printBanner({ secure, auth }) {
  const scheme = secure ? 'https' : 'http';
  log('SYS', `sync-audio 服务端已启动（本机声音共享 + 时钟同步 + PCM 广播${secure ? ' + TLS' : ''}）`);
  log('SYS', `监听地址: ${scheme}://${config.HOST}:${config.PORT}`);
  log('SYS', `本机访问: ${scheme}://localhost:${config.PORT}`);
  for (const { name, address } of lanAddresses()) {
    log('SYS', `局域网访问 (${name}): ${scheme}://${address}:${config.PORT}`);
  }
  log('SYS', `静态目录: ${config.CLIENT_DIR}`);
  log('SYS', `上传目录: ${config.UPLOAD_DIR}`);

  const room = auth.getRoomPasswordForDisplay();
  const admin = auth.getAdminPasswordForDisplay();
  log('SYS', `房间密码: ${room || '已设置（scrypt 哈希，如需更换请登录控制台）'}`);
  log('SYS', `管理密码: ${admin || '已设置（scrypt 哈希）'}`);
  if (room || admin) {
    log('SYS', '密码以 scrypt 哈希保存，明文只在本次启动打印一次，请妥善记录');
  }
  log('SYS', `主机控制台: ${scheme}://localhost:${config.PORT}/host`);
  log('SYS', `客户端页面: ${scheme}://localhost:${config.PORT}/`);
}

async function start() {
  await fsp.mkdir(config.UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(config.CLIENT_DIR, { recursive: true });

  ffmpegStatus = ensureFfmpeg();
  if (ffmpegStatus.ok) {
    log(
      'SYS',
      `ffmpeg 已就绪: ${ffmpegStatus.version}${ffmpegStatus.note ? `（${ffmpegStatus.note}）` : ''}`,
    );
  } else {
    logError('SYS', `警告：${ffmpegStatus.error}`);
  }

  const indexFile = path.join(config.CLIENT_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) {
    logError('SYS', `警告：缺少 ${indexFile}，访问 / 会返回 404`);
  }

  const auth = new Auth({
    settingsPath: config.SETTINGS_PATH,
    sessionsPath: config.SESSIONS_PATH,
    sessionTtlMs: config.SESSION_TTL_MS,
    log,
    logError,
  });

  const metrics = new Metrics();

  let tls = null;
  if (config.TLS_CERT && config.TLS_KEY) {
    tls = { key: fs.readFileSync(config.TLS_KEY), cert: fs.readFileSync(config.TLS_CERT) };
    log('SYS', '已启用 TLS（TLS_CERT / TLS_KEY）');
  }
  const { server, secure } = createHttpServer({ tls });

  const rtcHub = new RtcHub({ log, logError });
  const ws = createWebSocket({ server, auth, rtcHub, metrics, log, logError });

  const broadcaster = new Broadcaster(ws.wss, { log, logError });

  let player = null;
  const systemShare = new SystemShare({
    broadcaster,
    shouldRun: () => !shuttingDown && player && player.source === 'system' && !player.paused,
    log,
    logError,
  });

  player = new Player({
    broadcaster,
    systemShare,
    uploadDir: config.UPLOAD_DIR,
    log,
    logError,
  });

  broadcaster.on('pcm', (block) => rtcHub.pushBlock(block));
  broadcaster.on('end', (info) => player.handleEnd(info));
  broadcaster.on('block', () => {
    metrics.incBlocks();
    metrics.setDriftRatio(broadcaster.driftRatio);
  });

  const upload = createUploadHandler({
    uploadDir: config.UPLOAD_DIR,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxPartHeaderBytes: config.MAX_PART_HEADER_BYTES,
    log,
    logError,
  });

  const serveStatic = createStaticHandler({
    clientDir: config.CLIENT_DIR,
    log,
    logError,
  });

  const api = createApi({
    auth,
    player,
    systemShare,
    broadcaster,
    metrics,
    clients: ws.clients,
    uploadDir: config.UPLOAD_DIR,
    getFfmpegStatus: () => ffmpegStatus,
    maxJsonBodyBytes: config.MAX_JSON_BODY_BYTES,
    log,
    logError,
  });

  server.on('request', createRequestHandler({ api, auth, upload, serveStatic, log, logError }));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logError('SYS', `端口 ${config.PORT} 已被占用，请先结束占用进程再启动`);
    } else {
      logError('SYS', `HTTP 服务器错误: ${err.message}`);
    }
    process.exitCode = 1;
  });

  ws.startHeartbeat();

  function shutdown(signal) {
    if (shuttingDown) return;
    log('SYS', `收到 ${signal}，正在关闭…`);
    shuttingDown = true;

    systemShare.shutdown();
    player.dispose();
    ws.stopHeartbeat();
    rtcHub.closeAll();
    broadcaster.stop('服务端关闭').catch(() => {});
    ws.closeAll();

    server.close(() => {
      log('SYS', '服务已停止');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.PORT, config.HOST, () => {
    printBanner({ secure, auth });
    if (process.env.SYNC_DISABLE_CAPTURE !== '1') {
      systemShare.start('startup');
      systemShare.startWatch();
    } else {
      log('SYS', 'SYNC_DISABLE_CAPTURE=1，跳过本机声音采集');
    }
  });
}

start().catch((err) => {
  logError('SYS', `启动失败: ${err.stack || err.message}`);
  process.exit(1);
});

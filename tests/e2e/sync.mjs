#!/usr/bin/env node
'use strict';

/**
 * 两端 headless 端到端校验：
 *   1. 用临时目录和固定密码起一个独立服务端（默认端口 3101，跳过采集）；
 *   2. 启动两个无头浏览器页面，用房间密码加入；
 *   3. 等时钟同步完成后，采集两端的 offset / residual / RTT；
 *   4. 输出「跨端时钟偏差」和心跳残差。
 *
 * 说明：真正的声音对齐需要麦克风回采；这里测的是排程所依赖的时钟偏差，
 * 也是跨设备同步误差的主要来源。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.E2E_PORT) || 3101;
const ROOM_PASSWORD = '1111';
const ADMIN_PASSWORD = 'Sync';
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS) || 6000;

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome/Edge，请用 CHROME_PATH 指定可执行文件');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`服务端未在 ${timeoutMs}ms 内就绪: ${url}`);
}

async function joinPage(page) {
  await page.bringToFront();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((password) => {
    document.getElementById('room-password').value = password;
  }, ROOM_PASSWORD);
  await page.click('#join-button');
  // 后台页面的 requestAnimationFrame 会被节流，必须用定时轮询
  await page.waitForFunction(() => window.__syncDebug && window.__syncDebug.synced === true, {
    timeout: 20000,
    polling: 100,
  });
}

async function readDebug(page) {
  return page.evaluate(() => window.__syncDebug || {});
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const browserPath = findBrowser();
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audio-e2e-'));
  const serverLog = [];

  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SYNC_SETTINGS_DIR: settingsDir,
      ROOM_PASSWORD,
      ADMIN_PASSWORD,
      ...(process.env.E2E_CAPTURE === '1' ? {} : { SYNC_DISABLE_CAPTURE: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  let browser = null;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/session`);

    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      protocolTimeout: 60000,
      args: ['--no-sandbox', '--disable-gpu', '--mute-audio', '--disable-dev-shm-usage'],
    });

    const pageA = await browser.newPage();
    await joinPage(pageA);
    const pageB = await browser.newPage();
    await joinPage(pageB);

    await sleep(SETTLE_MS);

    const samplesA = [];
    const samplesB = [];
    for (let i = 0; i < 3; i += 1) {
      samplesA.push(await readDebug(pageA));
      samplesB.push(await readDebug(pageB));
      await sleep(2000);
    }

    const offsetsA = samplesA.map((s) => s.offset).filter(Number.isFinite);
    const offsetsB = samplesB.map((s) => s.offset).filter(Number.isFinite);
    const residualA = samplesA.map((s) => s.residual).filter(Number.isFinite);
    const residualB = samplesB.map((s) => s.residual).filter(Number.isFinite);

    const offsetA = median(offsetsA);
    const offsetB = median(offsetsB);
    const skew = Math.abs(offsetA - offsetB);

    const latestA = samplesA[samplesA.length - 1] || {};
    const latestB = samplesB[samplesB.length - 1] || {};

    // 校验 /metrics 是否真的带上了客户端统计
    const login = await fetch(`http://127.0.0.1:${PORT}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const metricsText = await (
      await fetch(`http://127.0.0.1:${PORT}/metrics`, { headers: { Cookie: cookie } })
    ).text();
    const metricValue = (name) => {
      const match = new RegExp(`^${name} (\\S+)$`, 'm').exec(metricsText);
      return match ? Number(match[1]) : null;
    };

    const report = {
      port: PORT,
      pair: 'headless A/B',
      offsetMs: { a: Number(offsetA.toFixed(2)), b: Number(offsetB.toFixed(2)) },
      skewMs: Number(skew.toFixed(2)),
      residualMs: {
        a: residualA.length ? Number(median(residualA).toFixed(2)) : null,
        b: residualB.length ? Number(median(residualB).toFixed(2)) : null,
      },
      rttMs: {
        a: latestA.rtt !== undefined ? Number(latestA.rtt.toFixed(1)) : null,
        b: latestB.rtt !== undefined ? Number(latestB.rtt.toFixed(1)) : null,
      },
      bufferMs: { a: latestA.bufferMs ?? null, b: latestB.bufferMs ?? null },
      late: { a: latestA.late ?? null, b: latestB.late ?? null },
      metrics: {
        clients: metricValue('sync_audio_clients'),
        blocksTotal: metricValue('sync_audio_blocks_total'),
        driftRatio: metricValue('sync_audio_drift_ratio'),
      },
    };

    console.log('=== sync e2e ===');
    console.log(JSON.stringify(report, null, 2));

    if (skew > 50) {
      console.error(`跨端时钟偏差 ${skew.toFixed(1)}ms 超过 50ms 阈值`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('e2e 失败:', err.message);
    console.error(serverLog.join('').split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
}

main();

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeFilename,
  MultipartParser,
} from '../../server/http/upload.js';
import { resolveUploadedFile } from '../../server/http/api.js';
import { sanitizeStats } from '../../server/ws.js';
import { Metrics } from '../../server/metrics.js';
import { HttpError } from '../../server/http/body.js';

test('sanitizeFilename: 去掉路径与控制字符', () => {
  assert.equal(sanitizeFilename('../../evil.mp3'), 'evil.mp3');
  assert.equal(sanitizeFilename('a<b>c.mp3'), 'a_b_c.mp3');
  assert.equal(sanitizeFilename('  song .mp3  '), 'song .mp3');
  assert.ok(sanitizeFilename('').endsWith('.mp3'));
});

test('resolveUploadedFile: 拒绝目录穿越和隐藏文件', () => {
  assert.throws(() => resolveUploadedFile('../x.mp3', '/uploads'), HttpError);
  assert.throws(() => resolveUploadedFile('/etc/passwd', '/uploads'), HttpError);
  assert.throws(() => resolveUploadedFile('.hidden.mp3', '/uploads'), HttpError);

  const ok = resolveUploadedFile('a.mp3', '/uploads');
  assert.equal(ok.name, 'a.mp3');
  assert.equal(ok.filePath.replace(/\\/g, '/').endsWith('/uploads/a.mp3'), true);
});

test('MultipartParser: 分块输入也能拼出文件内容', () => {
  const body = Buffer.from(
    '--BOUND\r\n' +
      'Content-Disposition: form-data; name="file"; filename="x.mp3"\r\n' +
      'Content-Type: audio/mpeg\r\n\r\n' +
      'HELLO-PCM\r\n' +
      '--BOUND--\r\n',
  );

  const parts = [];
  let filename = null;
  const parser = new MultipartParser('BOUND', {
    onPartBegin(headers) {
      const match = /filename="([^"]+)"/.exec(headers['content-disposition'] || '');
      if (match) filename = match[1];
    },
    onPartData(chunk) {
      parts.push(chunk);
    },
  });

  // 故意在每个字节处切分，验证边界前缀缓存逻辑
  for (const byte of body) parser.feed(Buffer.from([byte]));

  assert.equal(filename, 'x.mp3');
  assert.equal(Buffer.concat(parts).toString(), 'HELLO-PCM');
  assert.equal(parser.finished, true);
});

test('sanitizeStats: 非法数值归零并做上限保护', () => {
  assert.deepEqual(sanitizeStats({ bufferMs: 80, late: 2, underruns: 1, scheduleErrorMs: 0.5, rtc: true }), {
    bufferMs: 80,
    late: 2,
    underruns: 1,
    scheduleErrorMs: 0.5,
    rtc: true,
  });

  const cleaned = sanitizeStats({ bufferMs: -5, late: 'x', underruns: NaN, scheduleErrorMs: -1, rtc: 0 });
  assert.deepEqual(cleaned, { bufferMs: 0, late: 0, underruns: 0, scheduleErrorMs: 0, rtc: false });
});

test('Metrics: 渲染 Prometheus 文本并包含客户端指标', () => {
  const metrics = new Metrics();
  metrics.incBlocks(3);
  metrics.setClients(2);
  metrics.setRtcPeers(1);
  metrics.setDriftRatio(0.99842);
  metrics.updateClient(1, { bufferMs: 80, late: 0, underruns: 0, scheduleErrorMs: 0, rtc: false });

  const text = metrics.render();
  assert.match(text, /sync_audio_clients 2/);
  assert.match(text, /sync_audio_blocks_total 3/);
  assert.match(text, /sync_audio_drift_ratio 0\.99842/);
  assert.match(text, /sync_audio_client_buffer_ms\{client="1"\} 80/);

  metrics.removeClient(1);
  assert.equal(metrics.clientStats.size, 0);
});

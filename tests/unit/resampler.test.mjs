import test from 'node:test';
import assert from 'node:assert/strict';

import { LinearResampler } from '../../server/lib/resampler.js';

function sineBlock(samples, frequency, sampleRate, startPhase = 0) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * (startPhase + i)) / sampleRate) * 12000);
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

function goertzel(frame, frequency, sampleRate) {
  const n = frame.length;
  const k = Math.round((n * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = frame[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

test('LinearResampler: 44.1k 一秒产生约 48k 样本', () => {
  const resampler = new LinearResampler({ inputRate: 44100, outputRate: 48000, frameSize: 960 });
  for (let i = 0; i < 50; i += 1) {
    resampler.push(sineBlock(882, 440, 44100, i * 882));
  }

  let frames = 0;
  while (resampler.readFrame()) frames += 1;
  // 50 块 × 882 = 44100 样本；首帧需要约 882 个输入样本预热，最后一帧不足
  assert.ok(frames >= 48 && frames <= 50, `帧数 ${frames} 应在 48–50 之间`);
});

test('LinearResampler: 输出仍保持 440Hz', () => {
  const resampler = new LinearResampler({ inputRate: 44100, outputRate: 48000, frameSize: 960 });
  for (let i = 0; i < 20; i += 1) {
    resampler.push(sineBlock(882, 440, 44100, i * 882));
  }

  const frame = resampler.readFrame();
  assert.ok(frame, '应能读到一帧');
  const tone = goertzel(frame, 440, 48000);
  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
  const amplitude = Math.sqrt(energy / frame.length);
  assert.ok(tone / amplitude > 5, `440Hz 能量应显著高于平均，实际 ${(tone / amplitude).toFixed(2)}`);
});

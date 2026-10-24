import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Player } from '../../server/player.js';

function setup(files = ['a.mp3', 'b.mp3']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audio-player-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');

  const calls = [];
  const broadcaster = {
    playing: true,
    sourceKind: 'file',
    filename: 'b.mp3',
    seq: 49,
    async stop() {
      this.playing = false;
    },
    async play(filePath, filename, options = {}) {
      calls.push({ filePath, filename, options });
      this.playing = true;
      this.sourceKind = 'file';
      this.filename = filename;
      this.seq = 0;
    },
  };

  const systemShare = {
    started: 0,
    async start() {
      this.started += 1;
      broadcaster.sourceKind = 'system';
      broadcaster.filename = '本机声音';
      broadcaster.playing = true;
      return true;
    },
  };

  const player = new Player({
    broadcaster,
    systemShare,
    uploadDir: dir,
    log: () => {},
    logError: () => {},
  });

  return { dir, player, broadcaster, systemShare, calls };
}

test('Player: 列表按文件名排序并过滤非音频', () => {
  const { player, dir } = setup(['b.mp3', 'a.mp3', 'cover.png']);
  assert.deepEqual(player.listTracks(), ['a.mp3', 'b.mp3']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Player: 暂停记录块位置，继续时从该位置续播', async () => {
  const { player, calls, dir } = setup();
  player.source = 'library';

  const paused = await player.pause(true);
  assert.equal(paused.paused, true);
  assert.equal(paused.mode, 'paused');
  assert.equal(player.pausedPositionMs, 1000); // (49 + 1) * 20ms
  assert.equal(player.pausedFile, 'b.mp3');

  await player.pause(false);
  assert.equal(player.paused, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, 'b.mp3');
  assert.equal(calls[0].options.startAtMs, 1000);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Player: 下一首从 b 绕回 a，上一首从 a 回到 b', async () => {
  const { player, broadcaster, dir } = setup();

  const next = await player.playAdjacent(1);
  assert.equal(next.filename, 'a.mp3');
  assert.equal(broadcaster.filename, 'a.mp3');

  const prev = await player.playAdjacent(-1);
  assert.equal(prev.filename, 'b.mp3');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Player: 本机声音模式下 next 从第一首开始', async () => {
  const { player, broadcaster, dir } = setup();
  broadcaster.sourceKind = 'system';
  broadcaster.filename = '本机声音';

  const next = await player.playAdjacent(1);
  assert.equal(next.filename, 'a.mp3');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Player: 空曲库切到曲库会报 404', async () => {
  const { player, dir } = setup([]);
  await assert.rejects(() => player.setSource('library'), /曲库为空/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Player: 切到本机声音会调用采集并更新状态', async () => {
  const { player, systemShare, dir } = setup();
  const state = await player.setSource('system');
  assert.equal(systemShare.started, 1);
  assert.equal(state.source, 'system');
  assert.equal(state.mode, 'system');
  fs.rmSync(dir, { recursive: true, force: true });
});

'use strict';

/**
 * WebRTC / Opus 出口（混合模式用）。
 *
 * 服务端把已经采集好的 44.1kHz 单声道 PCM 重采样到 48kHz，用 Opus 编码后通过
 * werift 的 RTP 发送器推给每个已连接的客户端。客户端用原生 RTCPeerConnection
 * 接收（recvonly），浏览器自带 jitter buffer，适合公网/高抖动场景。
 *
 * 局域网仍然走原来的 PCM over WebSocket（块级精确排程），两条路互不影响。
 */

const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');
const OpusScript = require('opusscript');

const OPUS_RATE = 48000;
const FRAME_SAMPLES = 960; // 20ms
const PAYLOAD_TYPE = 96;
const STEP = 44100 / 48000;

class RtcHub {
  constructor({ log = console.log, logError = console.error } = {}) {
    this.log = log;
    this.logError = logError;
    this.peers = new Map();
    this.encoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.AUDIO);
    this.samples = new Int16Array(0);
    this.pos = 0;
  }

  get activeCount() {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.ready) count += 1;
    return count;
  }

  async handleMessage(clientId, ws, message) {
    if (message.type === 'rtc_start') {
      await this.createPeer(clientId, ws);
      return;
    }

    const peer = this.peers.get(clientId);
    if (!peer) return;

    try {
      if (message.type === 'rtc_answer' && typeof message.sdp === 'string') {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      } else if (message.type === 'rtc_ice' && message.candidate) {
        await peer.pc.addIceCandidate(message.candidate);
      }
    } catch (err) {
      this.logError('RTC', `#${clientId} 信令处理失败: ${err.message}`);
    }
  }

  async createPeer(clientId, ws) {
    this.closePeer(clientId);

    const pc = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: 'audio' });
    const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
    const peer = { pc, transceiver, ssrc: track.ssrc, seq: 0, ts: 0, ready: false };
    this.peers.set(clientId, peer);

    pc.onicecandidate = (candidate) => {
      if (!candidate || ws.readyState !== 1) return;
      ws.send(
        JSON.stringify({
          type: 'rtc_ice',
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
        }),
      );
    };

    pc.connectionStateChange.subscribe((state) => {
      peer.ready = state === 'connected';
      this.log('RTC', `#${clientId} ${state}`);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer.sdp);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rtc_offer', sdp: offer.sdp }));
    } catch (err) {
      this.logError('RTC', `#${clientId} 创建 offer 失败: ${err.message}`);
      this.closePeer(clientId);
    }
  }

  closePeer(clientId) {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    this.peers.delete(clientId);
    try {
      peer.pc.close();
    } catch {
      /* 忽略 */
    }
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  /** 输入：1764 字节（882 个 44.1k 采样） */
  pushBlock(block) {
    if (this.peers.size === 0) return;

    const count = block.length >> 1;
    const start = this.samples.length;
    const next = new Int16Array(start + count);
    next.set(this.samples, 0);
    for (let i = 0; i < count; i += 1) next[start + i] = block.readInt16LE(i * 2);
    this.samples = next;

    while (this.samples.length - this.pos > FRAME_SAMPLES * STEP + 2) {
      const frame = new Int16Array(FRAME_SAMPLES);
      let pos = this.pos;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const index = Math.floor(pos);
        const frac = pos - index;
        const a = this.samples[index];
        const b = this.samples[index + 1] === undefined ? a : this.samples[index + 1];
        frame[i] = a + (b - a) * frac;
        pos += STEP;
      }
      this.pos = pos;

      const drop = Math.floor(this.pos) - 1;
      if (drop > 4096) {
        this.samples = this.samples.slice(drop);
        this.pos -= drop;
      }

      this.broadcastFrame(frame);
    }
  }

  broadcastFrame(frame) {
    let payload = null;
    for (const peer of this.peers.values()) {
      if (!peer.ready) continue;

      if (!payload) {
        try {
          payload = this.encoder.encode(frame, FRAME_SAMPLES);
        } catch (err) {
          this.logError('RTC', `Opus 编码失败: ${err.message}`);
          return;
        }
      }

      const rtp = new RtpPacket(
        new RtpHeader({
          payloadType: PAYLOAD_TYPE,
          sequenceNumber: peer.seq & 0xffff,
          timestamp: peer.ts >>> 0,
          ssrc: peer.ssrc,
          marker: peer.seq === 0,
        }),
        payload,
      );

      peer.transceiver.sender.sendRtp(rtp).catch(() => {});
      peer.seq += 1;
      peer.ts += FRAME_SAMPLES;
    }
  }
}

module.exports = { RtcHub, OPUS_RATE, FRAME_SAMPLES };

# sync-audio

**把一台电脑正在播放的声音，同步送到局域网 / 公网上的其他设备。**

服务端采集默认播放设备（WASAPI 环回）或解码上传的 MP3，切成 20ms 的 PCM 块，通过 WebSocket 广播；浏览器按时间戳排程播放。时钟用简化 NTP 校正，高延迟网络可自动切换到 WebRTC/Opus。

![界面截图](docs/screenshot.png)

## 特性

- **本机声音共享**：抓取当前默认播放设备（USB / 蓝牙 / HDMI / 板载声卡均可），无需切换设备、无需安装虚拟声卡驱动。
- **MP3 播放**：上传后由 FFmpeg 流式解码为 PCM，按实时节拍广播。
- **时钟同步**：5 次握手取中位数，之后每 30 秒用 RTT 最小样本渐进重校，抵消晶振漂移。
- **精确排程**：20ms 块 + `scheduledTime`，局域网内多设备对齐在毫秒级。
- **自适应抖动缓冲**：按丢块情况自动调整排程提前量，公网抖动时自动加深缓冲。
- **混合传输**：RTT ≤ 80ms 走 PCM over WebSocket；更高延迟自动切 WebRTC/Opus（约 50kbps）。
- **手动微调**：±200ms 滑杆，值会记住；用于对齐主机扬声器或补偿 iOS 输出延迟。
- **主机监听**：主机把收到的延迟音频放回真实声卡（可选输出设备），避免与采集端形成回环。
- 无 Express、无前端框架，除 `ws` / `werift` / `opusscript` 外无运行时依赖。

## 架构

```
┌──────────────┐   WASAPI loopback   ┌──────────────┐   20ms PCM 块     ┌──────────────┐
│ 默认播放设备 │ ──────────────────► │  loopback    │ ────────────────► │              │
└──────────────┘   (内嵌 C# 采集器)  │  capture.exe │                   │   Node 服务  │
                                    └──────────────┘                   │              │
┌──────────────┐      FFmpeg 解码                                       │  · 分块 1764B │
│  uploads/*.mp3│ ───────────────────────────────────────────────────► │  · 时钟/心跳  │
└──────────────┘                                                       │  · WS 广播    │
                                                                       │  · Opus 出口  │
                                                                       └──────┬───────┘
                                                                              │
                            ┌─────────────────────────────────────────────────┴──────────┐
                            │                                                                 │
                    PCM over WebSocket（局域网）                              WebRTC / Opus（公网）
                            │                                                                 │
                   ┌────────┴────────┐                                        ┌───────────────┴──────────┐
                   │ 浏览器 AudioContext │                                     │ RTCPeerConnection        │
                   │ 块级精确排程         │                                     │ 浏览器 jitter buffer     │
                   └─────────────────┘                                        └──────────────────────────┘
```

## 环境要求

- **Windows 10/11**（系统声音采集依赖 WASAPI；其他平台的采集尚未实现）
- **Node.js ≥ 18**
- **FFmpeg**（解码 MP3 / 重采样）。程序会依次查找 `FFMPEG_PATH`、`PATH`、`%LOCALAPPDATA%\ffmpeg\bin`、`C:\ffmpeg\bin`
- **.NET Framework 4.x**（系统自带 `csc.exe`，首次运行自动编译采集器，产物在 `%LOCALAPPDATA%\sync-audio\`）

## 快速开始

```powershell
git clone https://github.com/zjw0810/sync-audio.git
cd sync-audio
npm install
node server/index.js
```

打开 <http://localhost:3000>，点「加入同步」。

- 电脑上正常放歌 / 视频，手机打开 `http://<电脑IP>:3000`，点「加入同步」即可听到；
- 需要主机自己也听：见下文「主机监听」。

## 使用

### 共享本机声音

服务启动后自动采集默认播放设备，无需额外操作。默认设备被切换（插拔耳机、切虚拟声卡）时，服务端会在 5 秒内自动跟随并在日志中打印：

```
[SHARE] 默认播放设备已切换：「旧设备」→「新设备」，重新采集
```

### 播放上传的 MP3

```powershell
curl.exe -F "file=@music.mp3" http://localhost:3000/upload
curl.exe -X POST -H "Content-Type: application/json" -d '{"filename":"music.mp3"}' http://localhost:3000/play
```

文件播放结束后会自动回到本机声音共享。

### 主机监听（可选）

如果希望主机自己也听延迟后的声音（与手机一致），有两种方式：

1. **页面里选输出设备**（仅 `http://localhost:3000` 可用）：加入同步 → 「本机输出」→ 刷新设备 → 选择真实扬声器。首次刷新需要允许麦克风权限（浏览器只允许授权后枚举设备名，不会录音）。
2. **Windows 音量合成器**：把浏览器的输出单独设为真实扬声器，无需授权。

> 默认输出若是虚拟声卡（CABLE、Voicemod 等），电脑本身不会出声；这是预期行为。

### 传输模式

| 参数 | 行为 |
|---|---|
| 默认 | RTT ≤ 80ms 用 PCM/WS，否则自动切 WebRTC |
| `?transport=ws` | 强制 PCM over WebSocket（同步最精确） |
| `?transport=rtc` | 强制 WebRTC/Opus（抗抖动，带宽最低） |

状态栏会显示 `同步播放中 · WebRTC` 以示区分。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 客户端页面（`client/` 静态文件） |
| `POST` | `/upload` | multipart 字段 `file`，保存到 `uploads/`，返回 `{"filename":"..."}` |
| `POST` | `/play` | JSON `{"filename":"..."}`，开始播放 |
| `GET` | `/status` | `{sharing, kind, device, clients, level, ffmpeg}`，用于排障 |

## WebSocket 协议

服务端每块先发二进制 PCM（Int16、44100Hz、单声道、1764 字节 = 20ms），紧接着发 JSON：

```json
{"seq":0,"scheduledTime":1730000000000,"sampleRate":44100,"channels":1,"blockDurationMs":20}
```

| 消息 | 方向 | 作用 |
|---|---|---|
| `{"type":"sync","t1":...}` | C→S | 简化 NTP 请求 |
| `{"type":"sync_reply","t1":...,"t2":...}` | S→C | 立刻回填服务端时间 |
| `{"type":"heartbeat","serverTime":...}` | S→C | 每 2 秒，用于显示时钟偏差 |
| `{"type":"rtc_start"}` | C→S | 请求建立 WebRTC |
| `{"type":"rtc_offer","sdp":...}` / `rtc_answer` | 双向 | SDP 交换 |
| `{"type":"rtc_ice","candidate":...}` | 双向 | ICE 候选 |

时钟约定：所有时间戳均为 `Date.now()` 毫秒；`scheduledTime = 广播时刻 + 预缓冲`（本机声音 150ms，文件 300ms）。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径 |
| `SYNC_LIVE_PREBUFFER_MS` | `150` | 本机声音预缓冲；公网建议 300–500 |

## 目录结构

```
server/
  index.js              HTTP + WebSocket + 路由 + 心跳
  clock.js              （预留）
  rtc.js                WebRTC / Opus 出口
  audio/decoder.js      MP3 解码 + WASAPI 环回采集（内嵌 C# 采集器）
  audio/broadcaster.js  20ms 分块、节拍、广播、时钟补偿
client/
  index.html
  js/ws.js              连接、配对、NTP 校时、RTC 信令
  js/scheduler.js       缓冲队列、排程、输出延迟补偿
  js/ui.js              界面逻辑
uploads/                上传的音频
```

## 已知限制

- 系统声音采集仅支持 Windows。
- 没有鉴权：**不要直接暴露到公网而不加反向代理和访问控制**。
- 页面切到后台后定时器被节流，会断流；请保持前台（后续计划用 AudioWorklet + Worker 解决）。
- Safari 不暴露 `outputLatency`，iOS 需要手动补偿（滑杆值会持久化）。
- WebRTC 模式下由浏览器 jitter buffer 决定延迟，跨设备对齐约 20–50ms（PCM 模式约 1ms）。
- 公网部署若服务器有公网 IP 通常不需要 TURN；对称 NAT 等特殊网络仍需中继。

## Roadmap

- [ ] 鉴权与房间（多房间、密码）
- [ ] iOS 自动延迟校准（脉冲 + 麦克风回采）
- [ ] AudioWorklet 环形缓冲，替换逐块 `AudioBufferSourceNode`
- [ ] 断流自动重连时的无缝续播
- [ ] 非 Windows 平台的采集（macOS / Linux）

## 参考

- [snapcast](https://github.com/snapcast/snapcast) — 多房间音频同步的经典实现
- [beatsync](https://github.com/freeman-jiang/beatsync) — 浏览器多设备同步播放
- [gophercast](https://github.com/shricodev/gophercast) — 局域网同步扬声器

## License

[MIT](LICENSE)

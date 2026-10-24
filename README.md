# SyncAudio

**把一台电脑正在播放的声音，同步送到局域网 / 公网上的其他设备。**

主机端采集默认播放设备（WASAPI 环回）或解码上传的 MP3，切成 20ms 的 PCM 块，通过 WebSocket 广播；浏览器按时间戳排程播放。时钟用简化 NTP 校正，高延迟网络自动切换到 WebRTC/Opus。

界面分为两个入口：

- **客户端**（`/`）：输入房间密码加入，只保留时钟偏移和手动延迟两项控制。
- **主机控制台**（`/host`）：输入管理密码登录，查看运行状态、启停共享、修改房间密码，以及播放控制（当前曲目、上一首/下一首、上传曲目）。

![客户端界面](docs/screenshot.png)

## 特性

- **本机声音共享**：抓取当前默认播放设备（USB / 蓝牙 / HDMI / 板载声卡均可），无需切换设备、无需安装虚拟声卡驱动。
- **房间密码**：客户端必须输入正确的房间密码才能接入音频，密码随机会话、12 小时有效。
- **管理密码**：`/host` 控制台独立鉴权，房间密码与共享开关只有管理员能改。
- **MP3 播放**：上传后由 FFmpeg 流式解码为 PCM，按实时节拍广播。
- **曲目控制**：控制台显示当前曲名与序号，支持上一首/下一首、上传即播，播完自动切下一首。
- **音源切换**：控制台可在「本机声音」与「曲库」之间切换，切换时自动停掉旧音源。
- **暂停 / 继续**：暂停本机声音或文件播放；文件续播时用 `-ss` 从暂停位置继续。
- **时钟同步**：5 次握手取中位数，之后每 30 秒用 RTT 最小样本渐进重校，抵消晶振漂移。
- **精确排程**：20ms 块 + `scheduledTime`，局域网内多设备对齐在毫秒级。
- **自适应抖动缓冲**：按丢块情况自动调整排程提前量，公网抖动时自动加深缓冲。
- **混合传输**：RTT ≤ 80ms 走 PCM over WebSocket；更高延迟自动切 WebRTC/Opus（约 50kbps）。
- **手动微调**：±200ms 滑杆，值会记住；用于对齐主机扬声器或补偿 iOS 输出延迟。
- 无前端框架、无 Express；运行时依赖只有 `ws`、`werift`、`opusscript`。

## 架构

```
┌──────────────┐   WASAPI loopback   ┌──────────────┐   20ms PCM 块     ┌──────────────┐
│ 默认播放设备 │ ──────────────────► │  loopback    │ ────────────────► │              │
└──────────────┘   (内嵌 C# 采集器)  │  capture.exe │                   │   Node 服务  │
                                    └──────────────┘                   │              │
┌──────────────┐      FFmpeg 解码                                       │  · 分块 1764B │
│ uploads/*.mp3│ ───────────────────────────────────────────────────► │  · 时钟/心跳  │
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
- **FFmpeg**（解码 MP3 / 重采样）。依次查找 `FFMPEG_PATH`、`PATH`、`%LOCALAPPDATA%\ffmpeg\bin`、`C:\ffmpeg\bin`
- **.NET Framework 4.x**（系统自带 `csc.exe`，首次运行自动编译采集器，产物在 `%LOCALAPPDATA%\sync-audio\`）

## 快速开始

```powershell
git clone https://github.com/zjw0810/sync-audio.git
cd sync-audio
npm install
node server/index.js
```

启动后终端会打印两个密码和两个地址：

```
[SYS] 房间密码: 760029
[SYS] 管理密码: a5c1b76fd470
[SYS] 主机控制台: http://localhost:3000/host
[SYS] 客户端页面: http://localhost:3000/
```

- **客户端**：手机/其他电脑打开 `http://<电脑IP>:3000`，输入房间密码加入。
- **主机控制台**：`http://localhost:3000/host`，输入管理密码登录。

密码首次运行随机生成，保存在 `%LOCALAPPDATA%\sync-audio\settings.json`；也可以用环境变量 `ROOM_PASSWORD` / `ADMIN_PASSWORD` 覆盖。

## 使用

### 共享本机声音

服务启动后自动采集默认播放设备，无需额外操作。默认设备被切换（插拔耳机、切虚拟声卡）时，服务端会在 5 秒内自动跟随并在日志中打印：

```
[SHARE] 默认播放设备已切换：「旧设备」→「新设备」，重新采集
```

### 播放上传的 MP3

需要管理员会话（先登录 `/host`），或在同源页面里带 cookie 调用：

```powershell
curl.exe -b cookies.txt -F "file=@music.mp3" http://localhost:3000/upload
curl.exe -b cookies.txt -X POST -H "Content-Type: application/json" -d '{"filename":"music.mp3"}' http://localhost:3000/play
```

文件播放结束后会自动回到本机声音共享。

### 主机自己也想听

客户端页面会把收到的音频输出到浏览器的默认输出设备。如果默认输出正是被采集的设备（例如虚拟声卡），会形成回环；这时：

- 把 Windows 默认输出设为真实扬声器，再用「音量合成器」把音频源应用单独指到虚拟声卡；或
- 主机不加入房间，只让其他设备听。

### 传输模式

| 参数 | 行为 |
|---|---|
| 默认 | RTT ≤ 80ms 用 PCM/WS，否则自动切 WebRTC |
| `?transport=ws` | 强制 PCM over WebSocket（同步最精确） |
| `?transport=rtc` | 强制 WebRTC/Opus（抗抖动，带宽最低） |

状态栏显示“同步播放中 · WebRTC”以示区分。

## HTTP 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/` | 否 | 客户端页面 |
| `GET` | `/host` | 否 | 主机控制台页面 |
| `POST` | `/api/join` | 否 | `{"password":"..."}`，成功后种下 12 小时会话 Cookie |
| `POST` | `/api/admin/login` | 否 | `{"password":"..."}`，管理员会话 |
| `POST` | `/api/admin/logout` | 管理员 | 退出登录 |
| `GET` | `/api/session` | 否 | `{"role":"room"|"admin"|null}` |
| `GET` | `/api/admin/settings` | 管理员 | 采集设备、在线数、共享状态、房间密码 |
| `POST` | `/api/admin/settings` | 管理员 | `{"roomPassword":"..."}`，修改后踢掉所有房间会话 |
| `POST` | `/api/admin/share` | 管理员 | `{"enabled":true|false}` 启停共享 |
| `GET` | `/api/admin/now-playing` | 管理员 | 当前曲目、序号、总数、模式（file/system/idle） |
| `POST` | `/api/admin/player/next` | 管理员 | 下一首（当前为本机声音时从第一首开始） |
| `POST` | `/api/admin/player/prev` | 管理员 | 上一首（当前为本机声音时从最后一首开始） |
| `POST` | `/api/admin/player/pause` | 管理员 | `{"paused":true|false}`，省略则切换 |
| `POST` | `/api/admin/player/source` | 管理员 | `{"source":"system"|"library"}` 切换音源 |
| `POST` | `/upload` | 管理员 | multipart 字段 `file`，返回 `{"filename":"..."}` |
| `POST` | `/play` | 管理员 | JSON `{"filename":"..."}` |
| `GET` | `/status` | 管理员 | `{sharing, kind, device, clients, level, ffmpeg}` |

## WebSocket 协议

未携带有效会话 Cookie 的连接会以 `4001` 关闭。音频每块先发二进制 PCM（Int16、44100Hz、单声道、1764 字节 = 20ms），紧接着发 JSON：

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
| `PORT` | `3000` | 监听端口 |
| `ROOM_PASSWORD` | 随机 6 位 | 房间密码（优先级高于 `settings.json`） |
| `ADMIN_PASSWORD` | 随机 12 位 | 管理密码 |
| `TLS_CERT` / `TLS_KEY` | 空 | 同时提供则直接以 HTTPS 启动 |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径 |
| `SYNC_LIVE_PREBUFFER_MS` | `150` | 本机声音预缓冲；公网建议 300–500 |
| `SYNC_SETTINGS_DIR` | `%LOCALAPPDATA%\sync-audio` | 密码/会话存放目录（测试用） |
| `SYNC_DISABLE_CAPTURE` | 空 | 设为 `1` 时跳过本机声音采集（CI/测试用） |

## 目录结构

```
server/
  index.js              装配层：创建依赖、接线、启动/关闭
  config.js             路径、端口、超时、TLS 配置
  logger.js             统一日志格式
  auth.js               scrypt 密码、会话、登录限流
  metrics.js            /metrics 指标
  player.js             音源/暂停/曲目状态机
  capture.js            本机声音采集生命周期与设备跟随
  ws.js                 WebSocket 鉴权、NTP、心跳、客户端统计
  rtc.js                WebRTC / Opus 出口（复用 lib/resampler）
  lib/resampler.js      44.1k → 48k 线性重采样
  http/
    server.js           路由与 TLS/HTTP server
    body.js             JSON/文本响应、请求体读取
    static.js           静态文件（目录穿越防护）
    upload.js           流式 multipart
    api.js              登录、设置、播放控制、/status、/metrics
  audio/decoder.js      MP3 解码 + WASAPI 环回采集（内嵌 C#）
  audio/broadcaster.js  20ms 分块、节拍、广播、时钟补偿
client/
  index.html            客户端：密码加入 + 时钟偏移 + 手动延迟
  host.html             主机控制台：状态 / 音源 / 曲目 / 房间密码
  css/app.css           共用样式
  js/clock.js           时钟同步纯函数（可单测）
  js/ws.js              连接、配对、NTP、RTC 信令
  js/scheduler.js       缓冲队列、排程、输出延迟补偿
  js/ui.js              客户端逻辑 + stats 上报
  js/host.js            主机控制台逻辑
tests/
  unit/                 30 个单测（node:test）
  e2e/sync.mjs          两个 headless 客户端的端到端校验
docs/adr/               架构决策记录
deploy/Caddyfile        公网 HTTPS 反代示例
uploads/                上传的音频
```

## 测试与度量

```powershell
npm test           # 单元测试（node --test）
npm run test:e2e   # 两个无头浏览器客户端，输出跨端偏差
```

单元测试覆盖：

- 时钟：offset/RTT 公式、中位数、最佳样本、渐进修正；
- 重采样：44.1k→48k 帧数、440Hz 能量保持；
- 漂移补偿：线性插值、积压裁剪；
- 播放器：暂停位置、续播 `-ss`、上一首/下一首、空曲库；
- 鉴权：scrypt 迁移、会话持久化、改密踢人、限流；
- 上传：文件名清洗、目录穿越拦截、逐字节 multipart 解析；
- 度量：Prometheus 文本渲染、非法 stats 归零。

端到端脚本会自己起一个临时服务端（默认 3101，使用临时 `settings.json`），打开两个 Edge/Chrome 页面加入房间，采集 `window.__syncDebug` 里的 offset/residual/RTT，并校验 `/metrics`：

```json
{
  "offsetMs": { "a": -0.5, "b": -0.5 },
  "skewMs": 0,
  "residualMs": { "a": 0.5, "b": 0.5 },
  "rttMs": { "a": 1, "b": 1 },
  "bufferMs": { "a": 80, "b": 80 },
  "late": { "a": 0, "b": 0 },
  "metrics": { "clients": 2, "blocksTotal": 642, "driftRatio": 1.00212 }
}
```

> 说明：同机回环下两端时钟差应当接近 0；真实跨设备偏差需要麦克风回采，见 Roadmap。
> 默认 e2e 会关闭采集（`SYNC_DISABLE_CAPTURE=1`）以便在 CI/无声卡环境运行；想看真实缓冲与丢块，用 `E2E_CAPTURE=1 npm run test:e2e`。

## 可观测性

`GET /metrics`（管理员会话）输出 Prometheus 文本：

```
sync_audio_clients 2
sync_audio_rtc_peers 0
sync_audio_blocks_total 642
sync_audio_drift_ratio 0.99842
sync_audio_client_buffer_ms{client="1"} 80
sync_audio_client_late_blocks_total{client="1"} 0
sync_audio_client_underruns_total{client="1"} 0
```

客户端每 5 秒通过 WebSocket 上报 `bufferMs/late/underruns`，服务端按客户端 id 聚合；`/status` 也会返回 `metrics.snapshot()`。

## 安全

- 密码以 **scrypt**（随机盐 + 64 字节）保存，旧的明文 `settings.json` 启动时自动迁移；
- 登录失败限流：同一 IP 10 分钟 5 次失败 → 封禁 5 分钟（429 + `Retry-After`）；
- 会话：`HttpOnly; SameSite=Lax`，12 小时，持久化到 `sessions.json`；
- 修改房间密码会立刻让所有 room 会话失效并断开对应 WebSocket；
- 支持 `TLS_CERT` / `TLS_KEY` 直接起 HTTPS，或参考 [deploy/Caddyfile](deploy/Caddyfile) 用 Caddy 自动签发证书。

## 实测数据（本机，2026-10-24）

| 项目 | 结果 |
|---|---|
| 单元测试 | 30 个全部通过 |
| 两端 headless 时钟偏差 | 中位 0.0–0.5ms（同机回环） |
| 心跳残差 | ±0.5ms |
| 客户端缓冲 | 80ms（LAN） |
| 迟到块 | 0（5 分钟采样） |
| 1kHz 采集纯度 | tone/rms 1.38（理论 1.41） |
| 采样时钟补偿 | 0.9984–1.0021（随设备时钟变化） |

## 架构决策记录

- [ADR 0001：为什么是 20ms 块](docs/adr/0001-20ms-blocks.md)
- [ADR 0002：预缓冲 150ms / 300ms](docs/adr/0002-prebuffer.md)
- [ADR 0003：PCM + WebRTC 双通道](docs/adr/0003-hybrid-transport.md)
- [ADR 0004：密码哈希、会话与限流](docs/adr/0004-auth.md)

## 已知限制

- 系统声音采集仅支持 Windows。
- 房间密码哈希后不可回显：忘记只能在控制台重置；管理密码只能靠环境变量或删除 `settings.json`。
- 没有 CSRF token，状态修改接口依赖 `SameSite=Lax` 与同源；公网部署建议再加反向代理鉴权。
- 页面切到后台后定时器被节流，会断流；请保持前台。
- Safari 不暴露 `outputLatency`，iOS 需要手动补偿。
- WebRTC 模式下由浏览器 jitter buffer 决定延迟，跨设备对齐约 20–50ms（PCM 模式约 1ms）。
- 公网部署若服务器有公网 IP 通常不需要 TURN；对称 NAT 等特殊网络仍需中继。

## Roadmap

- [ ] 用麦克风回采做真实的跨设备声学偏差测试
- [ ] 多房间
- [ ] AudioWorklet 环形缓冲，替换逐块 `AudioBufferSourceNode`
- [ ] 非 Windows 平台的采集（macOS / Linux）
- [ ] CSRF token 与更细的审计日志

## 参考

- [snapcast](https://github.com/snapcast/snapcast) — 多房间音频同步的经典实现
- [beatsync](https://github.com/freeman-jiang/beatsync) — 浏览器多设备同步播放
- [gophercast](https://github.com/shricodev/gophercast) — 局域网同步扬声器

## License

[MIT](LICENSE)

# ADR 0003：PCM over WebSocket + WebRTC/Opus 双通道

- 状态：已采纳
- 日期：2026-10-23

## 背景

同步播放对传输有两个互相冲突的要求：

- **精确**：每个 20ms 块都有绝对 `scheduledTime`，客户端按时间线排程，跨设备误差可以做到毫秒级；
- **稳健**：公网丢包、抖动、NAT 环境下，TCP 上的 PCM 会累积延迟，慢客户端还会拖垮内存。

## 备选方案

| 方案 | 同步精度 | 弱网表现 | 带宽 | 复杂度 |
|---|---|---|---|---|
| 只用 PCM/WS | ~1ms | 差，丢包即断流 | 1.4Mbps | 低 |
| 只用 WebRTC/Opus | 20–50ms（浏览器 jitter buffer 决定） | 好，有 FEC/NACK/拥塞控制 | ~50kbps | 高 |
| 双通道按 RTT 切换 | LAN 1ms，WAN 20–50ms | 好 | 自适应 | 中 |

## 决定

- 客户端完成 NTP 校时后拿到 RTT；
- **RTT ≤ 80ms 走 PCM/WS**，保持块级排程；
- **RTT > 80ms 自动切 WebRTC/Opus**（werift + opusscript，服务端 sendonly）；
- 允许 `?transport=ws|rtc` 强制指定，便于对比和排障；
- 不引入 TURN：服务端有公网 IP 时 host candidate 可直连；对称 NAT 场景再补中继。

## 后果

- 两条播放路径需要分别维护：PCM 走 `scheduler.enqueue`，RTC 走 `createMediaStreamSource`；
- WebRTC 模式下放弃块级排程，跨设备对齐退化到 20–50ms，这是用精度换稳健；
- Opus 编码器（纯 JS）带来额外 CPU 开销，客户端数量多时需要评估；
- 80ms 是经验阈值，公网部署后应按实测 RTT 分布调整。

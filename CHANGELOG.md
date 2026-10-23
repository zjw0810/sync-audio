# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-23

首个可用版本。

### 新增

- **本机声音共享**：通过内嵌的 C# WASAPI 环回采集器抓取默认播放设备，自动编译、自动跟随默认设备切换。
- **MP3 播放**：`POST /upload` + `POST /play`，FFmpeg 流式解码，播放结束自动回到本机声音共享。
- **20ms PCM 广播**：Int16 / 44100Hz / 单声道，每块 1764 字节，二进制帧后紧跟 JSON 元数据帧。
- **简化 NTP 校时**：5 次握手取中位数；之后每 30 秒用 RTT 最小样本渐进重校；首次校时 3 秒兜底。
- **客户端精确排程**：`AudioBufferSourceNode` + `scheduledTime`，10ms 调度循环，自适应抖动缓冲。
- **输出延迟补偿**：使用 `AudioContext.outputLatency`，减少 iOS 等设备的手动校准量。
- **时钟漂移补偿**：服务端对采集流做自适应重采样，消除声卡时钟与系统时钟的偏差。
- **手动延迟滑杆**：±200ms，值持久化到 localStorage。
- **主机监听**：主机页面可选择真实输出设备，把延迟音频放回扬声器，并带防回环静音保护。
- **WebRTC/Opus 混合传输**：RTT > 80ms 自动切换到 werift + Opus 媒体轨（约 50kbps），局域网保持 PCM 精确同步。
- **状态接口**：`GET /status` 返回当前采集设备、客户端数、信号电平。
- **WebSocket 心跳**：每 2 秒广播服务端时间，界面显示时钟偏差残余。

### 已知问题

- 系统声音采集仅支持 Windows。
- 无鉴权，公网部署需自行加反向代理与访问控制。
- 页面切后台会因定时器节流断流。
- Safari 不暴露 `outputLatency`，iOS 仍需手动补偿。

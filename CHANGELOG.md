# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-10-23

### 新增

- **音源切换**：控制台在「本机声音」与「曲库」之间切换，旧音源自动停止。
- **暂停 / 继续**：支持暂停本机声音或文件播放；文件续播时记录块位置并用 `-ss` 从原位置继续。
- **接口**：`POST /api/admin/player/pause`、`POST /api/admin/player/source`；`now-playing` 增加 `source`、`paused`。

## [0.3.0] - 2026-10-23

### 新增

- **播放控制（主机控制台）**：显示当前曲目与序号，支持上一首/下一首、上传曲目（上传后立即播放）。
- **自动连播**：曲目播完自动切换到下一首；曲库为空或出错时回到本机声音共享。
- **曲目接口**：`GET /api/admin/now-playing`、`POST /api/admin/player/next`、`POST /api/admin/player/prev`。

## [0.2.1] - 2026-10-23

### 修复

- **PCM32 设备下的噪声**：采集器此前一律按 32 位浮点解析混音格式，遇到 32 位 PCM 的声卡（如部分 USB 耳机）会输出噪声。现在按 WAVEFORMATEXTENSIBLE 的 SubFormat 判断 float32 / PCM32 / PCM16 分别转换，未知格式输出静音。
- `--info` 增加 `float` 字段，便于确认采集格式。

## [0.2.0] - 2026-10-23

### 新增

- **前端拆分**：客户端页面（`/`）与主机控制台（`/host`）分离，共用一套商业风格样式。
- **房间密码**：客户端必须输入正确密码才能接入；会话 Cookie 有效期 12 小时，刷新免重复输入。
- **管理密码**：主机控制台独立登录，用于修改房间密码、启停共享。
- **密码持久化**：首次运行随机生成房间密码（6 位）与管理密码（12 位），保存到 `%LOCALAPPDATA%\sync-audio\settings.json`，并支持 `ROOM_PASSWORD` / `ADMIN_PASSWORD` 覆盖。
- **改密踢人**：管理员修改房间密码后，所有已加入设备立即断开并需要重新输入。
- **管理 API**：`/api/join`、`/api/admin/login`、`/api/admin/settings`、`/api/admin/share`、`/api/session`。

### 变更

- 客户端界面精简为「时钟偏移 + 手动延迟」，移除输出设备选择、试听、缓冲/信号等调试项。
- WebSocket 未授权连接以 `4001` 关闭。
- `/upload`、`/play`、`/status` 需要管理员会话。
- 默认输出音量拉满。

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

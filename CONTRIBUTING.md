# 贡献指南

感谢你有兴趣参与 sync-audio。这个项目目前以「局域网/小规模公网同步播放」为目标，欢迎提交 bug 修复、文档改进和新特性。

## 开发环境

- Windows 10/11
- Node.js ≥ 18
- FFmpeg（放到 `PATH` 或设置 `FFMPEG_PATH`）
- .NET Framework 4.x（系统自带，用于编译 WASAPI 采集器）

```powershell
git clone https://github.com/zjw0810/sync-audio.git
cd sync-audio
npm install
node server/index.js
```

## 分支与提交

- 从 `main` 切出功能分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)：
  - `feat: 支持多房间`
  - `fix: 修复 Safari 下输出设备切换`
  - `docs: 补充 WebRTC 部署说明`
- 一个 PR 只做一件事，避免混入无关格式化改动。

## 代码约定

- 服务端使用 CommonJS，客户端使用原生 ES Module；不引入前端框架。
- 不要使用 `Express`；HTTP 用 Node 内置模块，WebSocket 用 `ws`。
- 时间戳统一使用 `Date.now()` 毫秒，禁止混用 `performance.now()` / `hrtime`。
- PCM 固定为 Int16 / 44100Hz / 单声道 / 20ms 一块（1764 字节）。
- 修改协议字段或时间基准前，请先开 issue 讨论。
- 采集器（C#）源码内嵌在 `server/audio/decoder.js` 中，修改后首次启动会自动重新编译。

## 测试

当前以手工验证为主，提交 PR 前请至少确认：

1. `node server/index.js` 能启动，终端打印监听地址与本机声音共享状态；
2. 浏览器打开 `http://localhost:3000`，加入同步后有声音、`/status` 中 `sharing` 为 `true`；
3. `?transport=ws` 与 `?transport=rtc` 两种模式都能出声；
4. 断开重连后能恢复播放。

## 提交 PR

- 说明改动动机、实现方式和验证步骤；
- 如果涉及界面改动，附截图；
- 如果涉及协议或目录结构变化，请在描述中明确列出。

## 安全问题

请勿在 issue 中公开安全漏洞，参见 [SECURITY.md](SECURITY.md)。

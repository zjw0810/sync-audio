'use strict';

/**
 * MP3 → PCM 流式解码器。
 *
 * 只用 child_process.spawn 调 FFmpeg，解码参数固定：
 *   ffmpeg -i <文件路径> -f s16le -ar 44100 -ac 1 -
 * 不加 -re（实时节拍由 broadcaster 控制），不 readFile，stdout 交给调用方流式消费。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const DEFAULT_COMMAND = 'ffmpeg';
const STDERR_TAIL_LIMIT = 8 * 1024;

/** 依次尝试的安装目录（用于找不到 PATH 里的 ffmpeg 时兜底）。 */
function fallbackDirs() {
  const dirs = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin'));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'ffmpeg', 'bin'));
  dirs.push('C:\\ffmpeg\\bin');
  return dirs;
}

function ffmpegExeName() {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function probeVersion(command) {
  try {
    const result = spawnSync(command, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return null;
    const firstLine = String(result.stdout || '').split(/\r?\n/)[0];
    return firstLine ? firstLine.trim() : 'ffmpeg';
  } catch {
    return null;
  }
}

/**
 * 确保 ffmpeg 可用。
 * - 优先用环境变量 FFMPEG_PATH（绝对路径）
 * - 其次用 PATH 中的 ffmpeg
 * - 最后探测常见安装目录，找到后把该目录补进当前进程的 PATH，
 *   这样真正 spawn 的命令仍然是字面量 `ffmpeg`。
 *
 * @returns {{ok: boolean, command: string, version?: string, note?: string, error?: string}}
 */
function ensureFfmpeg() {
  const configured = process.env.FFMPEG_PATH;
  if (configured) {
    const version = probeVersion(configured);
    if (version) return { ok: true, command: configured, version, note: '来自 FFMPEG_PATH' };
    return {
      ok: false,
      command: configured,
      error: `FFMPEG_PATH 指向的 ffmpeg 无法执行: ${configured}`,
    };
  }

  const onPath = probeVersion(DEFAULT_COMMAND);
  if (onPath) return { ok: true, command: DEFAULT_COMMAND, version: onPath };

  for (const dir of fallbackDirs()) {
    const exe = path.join(dir, ffmpegExeName());
    if (!fs.existsSync(exe)) continue;
    const version = probeVersion(exe);
    if (!version) continue;
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
    return {
      ok: true,
      command: DEFAULT_COMMAND,
      version,
      note: `已把 ${dir} 加入子进程 PATH`,
    };
  }

  return {
    ok: false,
    command: DEFAULT_COMMAND,
    error:
      '未找到 ffmpeg。请安装 FFmpeg 并加入系统 PATH，或设置环境变量 FFMPEG_PATH 指向 ffmpeg.exe；' +
      'Windows 可用: winget install Gyan.FFmpeg',
  };
}

class Mp3Decoder extends EventEmitter {
  /**
   * @param {string} filePath 已存在的 mp3 绝对/相对路径
   * @param {{command?: string}} [options]
   */
  constructor(filePath, options = {}) {
    super();
    this.filePath = path.resolve(filePath);
    this.command = options.command || process.env.FFMPEG_PATH || DEFAULT_COMMAND;
    this.child = null;
    this.stderr = '';
    this.exitInfo = null;
    this.startedAt = 0;
    this._resolveExit = null;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
  }

  /** 固定解码参数，顺序不可改。 */
  get args() {
    return [
      '-i',
      this.filePath,
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      String(CHANNELS),
      '-',
    ];
  }

  get stdout() {
    return this.child ? this.child.stdout : null;
  }

  start() {
    if (this.child) return this;
    this.startedAt = Date.now();

    const child = spawn(this.command, this.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      this.stderr = (this.stderr + text).slice(-STDERR_TAIL_LIMIT);
    });
    // 管道读错误也要兜住，避免未捕获异常
    child.stdout.on('error', (err) => {
      this.emit('error', new Error(`读取 ffmpeg stdout 失败: ${err.message}`));
    });

    child.on('error', (err) => {
      const message =
        err.code === 'ENOENT'
          ? `找不到 ffmpeg 可执行文件（命令: ${this.command}）。请安装 FFmpeg 并加入 PATH，或用 FFMPEG_PATH 指定路径。`
          : `启动 ffmpeg 失败: ${err.message}`;
      const wrapped = new Error(message);
      wrapped.code = err.code;
      this.emit('error', wrapped);
      this._settleExit({ code: null, signal: null, error: wrapped });
    });

    child.on('close', (code, signal) => {
      this._settleExit({ code, signal, stderr: this.stderr });
      this.emit('close', this.exitInfo);
    });

    return this;
  }

  _settleExit(info) {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this._resolveExit(info);
  }

  waitExit() {
    return this._exitPromise;
  }

  /** 终止解码进程（Windows 上等价于 TerminateProcess）。 */
  stop() {
    if (!this.child || this.exitInfo) return;
    try {
      this.child.kill();
    } catch {
      /* 进程可能已退出 */
    }
    const timer = setTimeout(() => {
      if (this.exitInfo) return;
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * WASAPI 环回采集器（Windows）。
 *
 * 作用：抓「当前默认播放设备」正在输出的声音——USB 耳机、蓝牙、HDMI、板载声卡都行，
 * 不依赖 Realtek 的「立体声混音」，也不需要用户切换默认设备。
 *
 * 链路：loopback.exe（WASAPI loopback，设备原生采样率/声道，s16le）
 *       → ffmpeg（重采样为 44100Hz 单声道 s16le）
 *       → 进入 broadcaster，走原有的 20ms 分块 + scheduledTime 广播。
 *
 * 首次使用时把内嵌的 C# 源码写到 %LOCALAPPDATA%\sync-audio\，用系统自带的
 * csc.exe（.NET Framework 4.x，Windows 自带）编译成 loopback-capture.exe，无需安装任何东西。
 */

const LOOPBACK_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'sync-audio');
const LOOPBACK_SRC_PATH = path.join(LOOPBACK_DIR, 'LoopbackCapture.cs');
const LOOPBACK_EXE_PATH = path.join(LOOPBACK_DIR, 'loopback-capture.exe');

const LOOPBACK_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Threading;

// WASAPI loopback capture of the CURRENT DEFAULT playback device.
// stdout: raw s16le, device mix rate, device channel count.
// --info: prints {"rate":48000,"channels":2} and exits.
static class Program
{
    const int eRender = 0;
    const int eConsole = 0;
    const int CLSCTX_ALL = 23;
    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        int OpenPropertyStore(int access, out IPropertyStore store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pointer;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [STAThread]
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new System.Text.UTF8Encoding(false); }
        catch { }

        bool info = args.Length > 0 && args[0] == "--info";

        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
        if (hr != 0) return 2;

        string deviceName = "";
        try
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) == 0)
            {
                var key = new PROPERTYKEY();
                key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
                key.pid = 14;
                PROPVARIANT pv;
                if (store.GetValue(ref key, out pv) == 0)
                {
                    deviceName = Marshal.PtrToStringUni(pv.pointer) ?? "";
                }
            }
        }
        catch
        {
            /* 名称取不到不影响采集 */
        }

        Guid clientIid = typeof(IAudioClient).GUID;
        object clientObj;
        hr = device.Activate(ref clientIid, CLSCTX_ALL, IntPtr.Zero, out clientObj);
        if (hr != 0) return 3;
        var audioClient = (IAudioClient)clientObj;

        IntPtr formatPtr;
        hr = audioClient.GetMixFormat(out formatPtr);
        if (hr != 0) return 4;
        var wfx = (WAVEFORMATEX)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEX));

        if (info)
        {
            string safeName = deviceName.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"");
            Console.Write("{\\"rate\\":" + wfx.nSamplesPerSec + ",\\"channels\\":" + wfx.nChannels + ",\\"bits\\":" + wfx.wBitsPerSample + ",\\"tag\\":" + wfx.wFormatTag + ",\\"name\\":\\"" + safeName + "\\"}");
            return 0;
        }

        // 100ms shared-mode buffer; loopback needs a non-zero duration
        hr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            1000000, 0, formatPtr, IntPtr.Zero);
        if (hr != 0) return 5;

        Guid captureIid = typeof(IAudioCaptureClient).GUID;
        object captureObj;
        hr = audioClient.GetService(ref captureIid, out captureObj);
        if (hr != 0) return 6;
        var capture = (IAudioCaptureClient)captureObj;

        hr = audioClient.Start();
        if (hr != 0) return 7;

        var stdout = Console.OpenStandardOutput();
        int channels = wfx.nChannels;
        if (channels < 1) channels = 1;

        float[] floats = new float[1];
        byte[] bytes = new byte[1];

        while (true)
        {
            uint packetFrames;
            if (capture.GetNextPacketSize(out packetFrames) != 0) break;
            if (packetFrames == 0)
            {
                Thread.Sleep(3);
                continue;
            }

            IntPtr data;
            uint frames;
            uint flags;
            ulong devicePosition;
            ulong qpcPosition;
            if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) != 0) break;

            int sampleCount = (int)frames * channels;
            if (floats.Length < sampleCount) floats = new float[sampleCount];

            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
            {
                Array.Clear(floats, 0, sampleCount);
            }
            else
            {
                Marshal.Copy(data, floats, 0, sampleCount);
            }

            capture.ReleaseBuffer(frames);

            int byteCount = sampleCount * 2;
            if (bytes.Length < byteCount) bytes = new byte[byteCount];
            int k = 0;
            for (int i = 0; i < sampleCount; i++)
            {
                float v = floats[i];
                if (v > 1f) v = 1f;
                if (v < -1f) v = -1f;
                int s = (int)(v * 32767f);
                bytes[k++] = (byte)(s & 0xFF);
                bytes[k++] = (byte)((s >> 8) & 0xFF);
            }

            stdout.Write(bytes, 0, byteCount);
            stdout.Flush();
        }

        return 0;
    }
}
`;

function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** 确保 loopback-capture.exe 存在（源码变了或首次使用时重新编译）。 */
function ensureLoopbackHelper() {
  if (process.platform !== 'win32') {
    throw new Error('系统声音采集目前只支持 Windows（WASAPI loopback）');
  }

  fs.mkdirSync(LOOPBACK_DIR, { recursive: true });

  let sourceChanged = true;
  if (fs.existsSync(LOOPBACK_SRC_PATH)) {
    sourceChanged = fs.readFileSync(LOOPBACK_SRC_PATH, 'utf8') !== LOOPBACK_SOURCE;
  }
  if (sourceChanged) fs.writeFileSync(LOOPBACK_SRC_PATH, LOOPBACK_SOURCE, 'utf8');

  if (!sourceChanged && fs.existsSync(LOOPBACK_EXE_PATH)) return LOOPBACK_EXE_PATH;

  const csc = findCsc();
  if (!csc) {
    throw new Error('找不到 .NET Framework 编译器 csc.exe，无法编译系统声音采集器');
  }

  const result = spawnSync(
    csc,
    ['/nologo', '/target:exe', `/out:${LOOPBACK_EXE_PATH}`, LOOPBACK_SRC_PATH],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );

  if (result.status !== 0 || !fs.existsSync(LOOPBACK_EXE_PATH)) {
    const detail = String(result.stderr || result.stdout || (result.error && result.error.message) || '').trim();
    throw new Error(`编译系统声音采集器失败${detail ? `: ${detail}` : ''}`);
  }

  return LOOPBACK_EXE_PATH;
}

/** 读取默认播放设备的混音格式（采样率/声道数）。 */
function readDefaultRenderFormat(helperPath) {
  const result = spawnSync(helperPath, ['--info'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) {
    throw new Error(`无法读取默认播放设备（退出码 ${result.status}），请确认系统有可用的音频输出设备`);
  }
  try {
    const info = JSON.parse(String(result.stdout || '').trim());
    if (!info.rate || !info.channels) throw new Error('格式字段缺失');
    return {
      rate: Number(info.rate),
      channels: Number(info.channels),
      name: typeof info.name === 'string' ? info.name : '',
    };
  } catch (err) {
    throw new Error(`解析播放设备格式失败: ${err.message}`);
  }
}

class SystemCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.ffmpegCommand || process.env.FFMPEG_PATH || DEFAULT_COMMAND;
    this.helperPath = null;
    this.format = null;
    this.helper = null;
    this.ffmpeg = null;
    this.stderr = '';
    this.exitInfo = null;
    this._resolveExit = null;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
  }

  describe() {
    return this.format
      ? `默认播放设备「${this.format.name || '未知'}」 ${this.format.rate}Hz/${this.format.channels}ch → 44100Hz 单声道`
      : '默认播放设备';
  }

  get stdout() {
    return this.ffmpeg ? this.ffmpeg.stdout : null;
  }

  start() {
    if (this.ffmpeg) return this;

    this.helperPath = ensureLoopbackHelper();
    this.format = readDefaultRenderFormat(this.helperPath);

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(this.format.rate),
      '-ac',
      String(this.format.channels),
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      String(CHANNELS),
      'pipe:1',
    ];

    const helper = spawn(this.helperPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const ffmpeg = spawn(this.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.helper = helper;
    this.ffmpeg = ffmpeg;

    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (text) => {
      this.stderr = (this.stderr + text).slice(-STDERR_TAIL_LIMIT);
    });

    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (text) => {
      this.stderr = (this.stderr + text).slice(-STDERR_TAIL_LIMIT);
    });

    // 采集端输出直接作为 ffmpeg 的输入；任一端断开都会让 ffmpeg 结束
    helper.stdout.pipe(ffmpeg.stdin);
    helper.stdout.on('error', (err) => {
      this.emit('error', new Error(`读取采集器输出失败: ${err.message}`));
    });
    ffmpeg.stdin.on('error', () => {
      /* 采集器先退出时管道会关闭，忽略 EPIPE */
    });

    helper.on('error', (err) => {
      const wrapped = new Error(
        err.code === 'ENOENT' ? `找不到采集器: ${this.helperPath}` : `启动采集器失败: ${err.message}`,
      );
      this.emit('error', wrapped);
      this._settleExit({ code: null, signal: null, stderr: this.stderr, error: wrapped });
    });

    ffmpeg.on('error', (err) => {
      const wrapped = new Error(`启动 ffmpeg 失败: ${err.message}`);
      this.emit('error', wrapped);
      this._settleExit({ code: null, signal: null, stderr: this.stderr, error: wrapped });
    });

    ffmpeg.on('close', (code, signal) => {
      this._settleExit({ code, signal, stderr: this.stderr });
    });

    return this;
  }

  _settleExit(info) {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this._resolveExit(info);
  }

  waitExit() {
    return this._exitPromise;
  }

  stop() {
    for (const child of [this.ffmpeg, this.helper]) {
      if (!child) continue;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
}

module.exports = {
  Mp3Decoder,
  SystemCapture,
  ensureFfmpeg,
  ensureLoopbackHelper,
  readDefaultRenderFormat,
  SAMPLE_RATE,
  CHANNELS,
};

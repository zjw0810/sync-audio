'use strict';

const els = {
  pill: document.getElementById('status-pill'),
  statusText: document.getElementById('status-text'),
  login: document.getElementById('login'),
  panel: document.getElementById('panel'),
  loginForm: document.getElementById('login-form'),
  password: document.getElementById('admin-password'),
  loginError: document.getElementById('login-error'),
  loginButton: document.getElementById('login-button'),
  device: document.getElementById('device'),
  clients: document.getElementById('clients'),
  sharing: document.getElementById('sharing'),
  shareToggle: document.getElementById('share-toggle'),
  refresh: document.getElementById('refresh'),
  newPassword: document.getElementById('new-room-password'),
  settingsError: document.getElementById('settings-error'),
  settingsOk: document.getElementById('settings-ok'),
  savePassword: document.getElementById('save-password'),
  logout: document.getElementById('logout'),
  trackName: document.getElementById('track-name'),
  trackMeta: document.getElementById('track-meta'),
  prevTrack: document.getElementById('prev-track'),
  nextTrack: document.getElementById('next-track'),
  uploadTrack: document.getElementById('upload-track'),
  trackFile: document.getElementById('track-file'),
  sourceSystem: document.getElementById('source-system'),
  sourceLibrary: document.getElementById('source-library'),
  pauseToggle: document.getElementById('pause-toggle'),
};

let sharing = false;
let pollTimer = null;
let passwordLoaded = false;
let pausedState = false;
let currentSource = 'system';

function setStatus(kind, text) {
  els.pill.dataset.state = kind;
  els.statusText.textContent = text;
}

function showLogin(message) {
  els.panel.hidden = true;
  els.login.hidden = false;
  setStatus('idle', '未登录');
  if (message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function showPanel() {
  els.login.hidden = true;
  els.panel.hidden = false;
  setStatus('live', '已登录');
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401) {
    showLogin('登录已过期，请重新输入管理密码');
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function loadSettings() {
  const data = await request('/api/admin/settings');
  if (!data) return;

  els.device.textContent = data.device || '—';
  els.clients.textContent = String(data.clients ?? 0);
  sharing = Boolean(data.sharing);
  els.sharing.textContent = sharing ? '共享中' : '已停止';
  els.shareToggle.textContent = sharing ? '停止共享' : '开始共享';

  if (!passwordLoaded) {
    els.newPassword.value = data.roomPassword || '';
    passwordLoaded = true;
  }
}

async function loadNowPlaying() {
  const data = await request('/api/admin/now-playing');
  if (!data) return;

  pausedState = Boolean(data.paused);
  currentSource = data.source === 'library' ? 'library' : 'system';

  els.sourceSystem.classList.toggle('active', currentSource === 'system');
  els.sourceLibrary.classList.toggle('active', currentSource === 'library');
  els.pauseToggle.textContent = pausedState ? '继续' : '暂停';

  if (data.filename) {
    els.trackName.textContent = data.filename;
  } else {
    els.trackName.textContent = data.mode === 'idle' ? '未播放' : '本机声音';
  }

  if (data.paused) {
    els.trackMeta.textContent = data.filename
      ? `已暂停 · 第 ${data.index + 1} / ${data.total} 首`
      : '已暂停 · 本机声音';
  } else if (data.mode === 'file' && data.filename) {
    els.trackMeta.textContent = `第 ${data.index + 1} / ${data.total} 首`;
  } else {
    els.trackMeta.textContent = data.total ? `曲库 ${data.total} 首` : '曲库为空，可上传曲目';
  }
}

async function switchSource(source) {
  try {
    await request('/api/admin/player/source', {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
    await loadNowPlaying();
  } catch (err) {
    els.trackMeta.textContent = err.message;
  }
}

async function togglePause() {
  try {
    await request('/api/admin/player/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: !pausedState }),
    });
    await loadNowPlaying();
  } catch (err) {
    els.trackMeta.textContent = err.message;
  }
}

async function skip(direction) {
  els.prevTrack.disabled = true;
  els.nextTrack.disabled = true;

  try {
    await request(`/api/admin/player/${direction}`, { method: 'POST' });
    await loadNowPlaying();
  } catch (err) {
    els.trackMeta.textContent = err.message;
  } finally {
    els.prevTrack.disabled = false;
    els.nextTrack.disabled = false;
  }
}

async function uploadSelected(file) {
  if (!file) return;

  const original = els.uploadTrack.textContent;
  els.uploadTrack.disabled = true;
  els.uploadTrack.textContent = '上传中…';

  try {
    const form = new FormData();
    form.append('file', file);

    const response = await fetch('/upload', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '上传失败');

    await fetch('/play', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: data.filename }),
    });

    await loadNowPlaying();
  } catch (err) {
    els.trackMeta.textContent = err.message;
  } finally {
    els.uploadTrack.disabled = false;
    els.uploadTrack.textContent = original;
    els.trackFile.value = '';
  }
}

async function login() {
  els.loginButton.disabled = true;
  els.loginError.hidden = true;

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: els.password.value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '管理密码错误');

    showPanel();
    await loadSettings();
    await loadNowPlaying();
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        loadSettings().catch(() => {});
        loadNowPlaying().catch(() => {});
      }, 5000);
    }
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.hidden = false;
  } finally {
    els.loginButton.disabled = false;
  }
}

async function toggleShare() {
  try {
    const data = await request('/api/admin/share', {
      method: 'POST',
      body: JSON.stringify({ enabled: !sharing }),
    });
    if (!data) return;
    sharing = Boolean(data.sharing);
    els.sharing.textContent = sharing ? '共享中' : '已停止';
    els.shareToggle.textContent = sharing ? '停止共享' : '开始共享';
  } catch (err) {
    els.shareToggle.textContent = '操作失败';
    setTimeout(() => loadSettings().catch(() => {}), 1200);
    console.error(err);
  }
}

async function savePassword() {
  els.settingsError.hidden = true;
  els.settingsOk.hidden = true;

  try {
    await request('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ roomPassword: els.newPassword.value.trim() }),
    });
    els.settingsOk.hidden = false;
    setTimeout(() => {
      els.settingsOk.hidden = true;
    }, 2500);
  } catch (err) {
    els.settingsError.textContent = err.message;
    els.settingsError.hidden = false;
  }
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* 忽略 */
  }
  passwordLoaded = false;
  window.location.reload();
}

async function bootstrap() {
  try {
    const response = await fetch('/api/session', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (data && data.role === 'admin') {
      showPanel();
      await loadSettings();
      await loadNowPlaying();
      pollTimer = setInterval(() => {
        loadSettings().catch(() => {});
        loadNowPlaying().catch(() => {});
      }, 5000);
      return;
    }
  } catch {
    /* 忽略 */
  }
  showLogin();
}

els.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  login().catch((err) => console.error(err));
});

els.shareToggle.addEventListener('click', () => {
  toggleShare().catch((err) => console.error(err));
});

els.refresh.addEventListener('click', () => {
  loadSettings().catch((err) => console.error(err));
  loadNowPlaying().catch((err) => console.error(err));
});

els.prevTrack.addEventListener('click', () => {
  skip('prev').catch((err) => console.error(err));
});

els.nextTrack.addEventListener('click', () => {
  skip('next').catch((err) => console.error(err));
});

els.sourceSystem.addEventListener('click', () => {
  switchSource('system').catch((err) => console.error(err));
});

els.sourceLibrary.addEventListener('click', () => {
  switchSource('library').catch((err) => console.error(err));
});

els.pauseToggle.addEventListener('click', () => {
  togglePause().catch((err) => console.error(err));
});

els.uploadTrack.addEventListener('click', () => {
  els.trackFile.click();
});

els.trackFile.addEventListener('change', () => {
  uploadSelected(els.trackFile.files && els.trackFile.files[0]).catch((err) => console.error(err));
});

els.savePassword.addEventListener('click', () => {
  savePassword().catch((err) => console.error(err));
});

els.logout.addEventListener('click', () => {
  logout().catch((err) => console.error(err));
});

bootstrap();

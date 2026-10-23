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
};

let sharing = false;
let pollTimer = null;
let passwordLoaded = false;

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
    if (!pollTimer) pollTimer = setInterval(() => loadSettings().catch(() => {}), 5000);
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
      pollTimer = setInterval(() => loadSettings().catch(() => {}), 5000);
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
});

els.savePassword.addEventListener('click', () => {
  savePassword().catch((err) => console.error(err));
});

els.logout.addEventListener('click', () => {
  logout().catch((err) => console.error(err));
});

bootstrap();

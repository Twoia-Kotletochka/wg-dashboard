const appScript = document.currentScript ? new URL(document.currentScript.src) : new URL('app.js', window.location.href);
const basePath = appScript.pathname.replace(/\/app\.js$/, '').replace(/\/$/, '');

function appUrl(path) {
  return `${basePath}/${String(path).replace(/^\/+/, '')}`;
}

const socket = io({
  autoConnect: false,
  path: appUrl('socket.io'),
});

const $status = document.getElementById('status');
const $list = document.getElementById('list');
const $addForm = document.getElementById('add-form');
const $add = document.getElementById('add');
const $name = document.getElementById('name');
const $refresh = document.getElementById('refresh');
const $restart = document.getElementById('restart');
const $search = document.getElementById('search');
const $logout = document.getElementById('logout');
const $notice = document.getElementById('notice');

let authHeader = '';
let sessionAuthenticated = false;
let peersCache = [];
let loginOverlay = null;

function setAuth(user, pass) {
  authHeader = `Basic ${btoa(`${user}:${pass}`)}`;
  connectSocket();
}

function clearAuth() {
  authHeader = '';
  sessionAuthenticated = false;
  socket.disconnect();
}

function handleUnauthorized(message = 'Нужна авторизация.') {
  clearAuth();
  showLogin(message);
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...extra,
  };
}

async function api(url, options = {}) {
  const res = await fetch(appUrl(url), {
    ...options,
    credentials: 'same-origin',
    headers: headers(options.headers || {}),
  });

  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || `${res.status} ${res.statusText}`);
  }

  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

function showNotice(message, type = 'error') {
  $notice.textContent = message;
  $notice.className = `notice notice-${type}`;
  $notice.hidden = false;
}

function clearNotice() {
  $notice.hidden = true;
  $notice.textContent = '';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = busy ? 'Подождите...' : label;
}

function fmtBytes(value) {
  let n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = -1;
  do {
    n /= 1024;
    unit += 1;
  } while (n >= 1024 && unit < units.length - 1);
  return `${n.toFixed(2)} ${units[unit]}`;
}

function fmtRate(value) {
  return `${fmtBytes(value)}/s`;
}

function createButton({ action, pub, label, variant = 'secondary', title }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button button-${variant}`;
  button.dataset.act = action;
  button.dataset.pub = pub;
  button.textContent = label;
  if (title) button.title = title;
  return button;
}

function createPeerCard(peer) {
  const card = document.createElement('article');
  card.className = 'client-card';

  const main = document.createElement('div');
  main.className = 'client-main';

  const title = document.createElement('div');
  title.className = 'client-title';

  const dot = document.createElement('span');
  dot.className = peer.online ? 'status-dot status-dot-online' : 'status-dot';
  dot.title = peer.online ? 'Онлайн' : 'Оффлайн';
  title.appendChild(dot);
  title.append(peer.name || 'unknown');

  const ip = document.createElement('span');
  ip.className = 'muted';
  ip.textContent = `(${peer.ip || 'no-ip'})`;
  title.appendChild(ip);

  const badge = document.createElement('span');
  badge.className = peer.blocked ? 'badge badge-blocked' : 'badge badge-active';
  badge.textContent = peer.blocked ? 'blocked' : 'active';
  title.appendChild(badge);

  const meta = document.createElement('div');
  meta.className = 'client-meta';
  meta.textContent = [
    `handshake: ${peer.latest || 'no handshake'}`,
    `rx: ${fmtBytes(peer.rx)} (${fmtRate(peer.rxRate)})`,
    `tx: ${fmtBytes(peer.tx)} (${fmtRate(peer.txRate)})`,
    peer.endpoint ? `endpoint: ${peer.endpoint}` : '',
  ].filter(Boolean).join(' | ');

  main.appendChild(title);
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(createButton({ action: 'conf', pub: peer.pub, label: 'Conf', title: 'Скачать конфиг' }));
  actions.appendChild(createButton({ action: 'qr', pub: peer.pub, label: 'QR', title: 'Показать QR' }));
  actions.appendChild(peer.blocked
    ? createButton({ action: 'unblock', pub: peer.pub, label: 'Разблокировать', variant: 'primary' })
    : createButton({ action: 'block', pub: peer.pub, label: 'Блокировать', variant: 'warning' }));
  actions.appendChild(createButton({ action: 'delete', pub: peer.pub, label: 'Удалить', variant: 'danger' }));

  card.appendChild(main);
  card.appendChild(actions);
  return card;
}

function render(peers) {
  const query = ($search.value || '').trim().toLowerCase();
  const filtered = peers
    .filter((peer) => {
      const haystack = [peer.name, peer.ip, peer.endpoint].filter(Boolean).join(' ').toLowerCase();
      return !query || haystack.includes(query);
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));

  $list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = peers.length ? 'По этому запросу клиентов нет.' : 'Клиентов пока нет.';
    $list.appendChild(empty);
    return;
  }

  filtered.forEach((peer) => $list.appendChild(createPeerCard(peer)));
}

function connectSocket() {
  if (!authHeader && !sessionAuthenticated) return;
  socket.auth = authHeader ? { authorization: authHeader } : {};
  if (!socket.connected) socket.connect();
}

async function refresh({ initial = false } = {}) {
  setBusy($refresh, true, 'Обновить');
  try {
    const peers = await api('/api/peers');
    peersCache = peers;
    render(peersCache);
    const status = await api('/api/status');
    $status.textContent = status.iface || 'WireGuard status is empty.';
    sessionAuthenticated = true;
    connectSocket();
    clearNotice();
  } catch (error) {
    if (error.message === 'unauthorized') {
      if (initial) {
        clearAuth();
        return showLogin();
      }
      return handleUnauthorized('Сессия истекла. Войдите снова.');
    }
    showNotice(`Ошибка обновления: ${error.message}`);
  } finally {
    setBusy($refresh, false, 'Обновить');
  }
}

async function downloadConfig(pub) {
  const res = await fetch(appUrl(`/api/conf?pub=${encodeURIComponent(pub)}`), {
    credentials: 'same-origin',
    headers: headers(),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(await res.text());

  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? decodeURIComponent(match[1]) : 'client.conf';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function showQr(pub) {
  const res = await fetch(appUrl(`/api/qr?pub=${encodeURIComponent(pub)}`), {
    credentials: 'same-origin',
    headers: headers(),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(await res.text());

  const url = URL.createObjectURL(await res.blob());
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'QR код клиента';
  const img = document.createElement('img');
  img.className = 'qr-image';
  img.alt = 'QR код WireGuard клиента';
  img.src = url;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'button button-danger';
  close.textContent = 'Закрыть';
  close.onclick = () => {
    URL.revokeObjectURL(url);
    overlay.remove();
  };

  modal.append(title, img, close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

$list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;

  const { act, pub } = button.dataset;
  try {
    clearNotice();
    if (act === 'delete' && !confirm('Удалить клиента?')) return;
    if (act === 'conf') return await downloadConfig(pub);
    if (act === 'qr') return await showQr(pub);

    setBusy(button, true);
    await api(`/api/${act}`, { method: 'POST', body: JSON.stringify({ pub }) });
  } catch (error) {
    if (error.message === 'unauthorized') return handleUnauthorized();
    showNotice(`Ошибка: ${error.message}`);
  } finally {
    setBusy(button, false);
  }
});

$addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = ($name.value || '').trim();
  if (!name) return showNotice('Введите имя клиента.');

  setBusy($add, true, 'Добавить');
  try {
    await api('/api/add', { method: 'POST', body: JSON.stringify({ name }) });
    $name.value = '';
    clearNotice();
  } catch (error) {
    if (error.message === 'unauthorized') return handleUnauthorized();
    showNotice(`Ошибка добавления: ${error.message}`);
  } finally {
    setBusy($add, false, 'Добавить');
  }
});

$refresh.addEventListener('click', refresh);
$restart.addEventListener('click', async () => {
  if (!confirm('Перезапустить интерфейс WireGuard?')) return;
  setBusy($restart, true, 'Перезапустить WG');
  try {
    await api('/api/restart', { method: 'POST' });
    showNotice('WireGuard перезапущен.', 'success');
  } catch (error) {
    if (error.message === 'unauthorized') return handleUnauthorized();
    showNotice(`Ошибка перезапуска: ${error.message}`);
  } finally {
    setBusy($restart, false, 'Перезапустить WG');
  }
});
$search.addEventListener('input', () => render(peersCache));
$logout.addEventListener('click', async () => {
  setBusy($logout, true, 'Выйти');
  try {
    const res = await fetch(appUrl('/api/logout'), {
      credentials: 'same-origin',
      headers: headers(),
      method: 'POST',
    });
    if (!res.ok) throw new Error(await res.text());
    clearAuth();
    peersCache = [];
    render(peersCache);
    $status.textContent = 'Статус появится после авторизации.';
    showLogin();
  } catch (error) {
    showNotice(`Ошибка выхода: ${error.message}`);
  } finally {
    setBusy($logout, false, 'Выйти');
  }
});

function showLogin(message = '') {
  if (loginOverlay) {
    const existingError = loginOverlay.querySelector('.modal-error');
    if (existingError && message) {
      existingError.textContent = message;
      existingError.hidden = false;
    }
    return;
  }
  socket.disconnect();

  loginOverlay = document.createElement('div');
  loginOverlay.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  const title = document.createElement('h2');
  title.textContent = 'Авторизация';

  const form = document.createElement('form');
  form.className = 'modal-form';

  const error = document.createElement('div');
  error.className = 'notice notice-error modal-error';
  error.hidden = !message;
  error.textContent = message;

  const user = document.createElement('input');
  user.className = 'input';
  user.placeholder = 'Логин';
  user.autocomplete = 'username';

  const pass = document.createElement('input');
  pass.className = 'input';
  pass.type = 'password';
  pass.placeholder = 'Пароль';
  pass.autocomplete = 'current-password';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button button-primary';
  submit.textContent = 'Войти';

  form.append(error, user, pass, submit);
  modal.append(title, form);
  loginOverlay.appendChild(modal);
  document.body.appendChild(loginOverlay);
  user.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = user.value.trim();
    const password = pass.value;
    if (!username || !password) {
      error.textContent = 'Введите логин и пароль.';
      error.hidden = false;
      return;
    }
    setAuth(username, password);
    loginOverlay.remove();
    loginOverlay = null;
    await refresh();
  });
}

socket.on('status', (status) => {
  $status.textContent = status.text || '';
});
socket.on('peers', (peers) => {
  peersCache = peers;
  render(peersCache);
});
socket.on('connect_error', (error) => {
  if (error.message === 'unauthorized') return handleUnauthorized('Сессия истекла. Войдите снова.');
  if (error.message === 'forbidden') showNotice('Доступ к live-обновлениям запрещён для текущего IP.');
});

refresh({ initial: true });

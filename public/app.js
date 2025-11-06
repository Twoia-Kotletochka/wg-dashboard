// /opt/wg-dashboard/public/app.js
const socket = io();

const $status = document.getElementById('status');
const $list = document.getElementById('list');
const $add = document.getElementById('add');
const $name = document.getElementById('name');
const $refresh = document.getElementById('refresh');
const $restart = document.getElementById('restart');
const $search = document.getElementById('search');

let authHeader = '';

function setAuth(user, pass) {
    authHeader = 'Basic ' + btoa(user + ':' + pass);
    localStorage.setItem('WG_USER', user);
    localStorage.setItem('WG_PASS', pass);
}

function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (authHeader) h['Authorization'] = authHeader;
    return h;
}

async function api(path, opt = {}) {
    const res = await fetch(path, { headers: headers(), ...opt });
    if (res.status === 401) throw new Error('unauthorized');
    if (!res.ok) throw new Error(await res.text());
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
}

function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(2) + ' ' + u[i];
}
function fmtRate(bps) { return fmtBytes(bps) + '/s'; }

let peersCache = [];

function row(peer) {
    const online = peer.online ? '🟢' : '🔴';
    const blocked = peer.blocked
        ? '<span class="pill bg-red-700">🚫 blocked</span>'
        : '<span class="pill bg-green-700">active</span>';
    const ep = peer.endpoint ? ` · ${peer.endpoint}` : '';
    return `
  <div class="bg-gray-800 p-3 rounded">
    <div class="flex items-center justify-between">
      <div>
        <div class="font-semibold">
          ${online} ${peer.name}
          <span class="text-gray-400 text-xs">(${peer.ip})</span> ${blocked}
        </div>
        <div class="text-xs text-gray-400">
          hs: ${peer.latest} ·
          rx: ${fmtBytes(peer.rx)} (${fmtRate(peer.rxRate || 0)}) ·
          tx: ${fmtBytes(peer.tx)} (${fmtRate(peer.txRate || 0)})${ep}
        </div>
      </div>
      <div class="flex gap-2">
            <button class="bg-gray-700 px-2 py-1 rounded" data-act="conf" data-pub="${peer.pub}">📄</button>
            <button class="bg-gray-700 px-2 py-1 rounded" data-act="qr" data-pub="${peer.pub}">📱</button>
        ${peer.blocked
            ? `<button class="bg-green-700 px-2 py-1 rounded" data-act="unblock" data-pub="${peer.pub}">✅</button>`
            : `<button class="bg-yellow-700 px-2 py-1 rounded" data-act="block" data-pub="${peer.pub}">🚫</button>`}
        <button class="bg-red-700 px-2 py-1 rounded" data-act="delete" data-pub="${peer.pub}">🗑</button>
      </div>
    </div>
  </div>`;
}

const $logout = document.getElementById('logout');
if ($logout) {
    $logout.onclick = () => {
        localStorage.removeItem('WG_USER');
        localStorage.removeItem('WG_PASS');
        alert('Вы вышли из панели');
        location.reload();
    };
}

function render(peers) {
    const q = ($search.value || '').trim().toLowerCase();
    let filtered = peers;
    if (q) filtered = peers.filter(p => (p.name + p.ip + p.endpoint).toLowerCase().includes(q));
    filtered.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    $list.innerHTML = filtered.length ? filtered.map(row).join('') : '<div class="text-gray-400">Клиентов нет</div>';
    $list.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = async () => {
            const act = btn.dataset.act;
            const pub = btn.dataset.pub;

            try {
                if (act === 'delete' && !confirm('Удалить клиента?')) return;

                if (act === 'conf') {
                    // Скачиваем конфиг через fetch и берём имя из заголовка
                    const res = await fetch(`/api/conf?pub=${encodeURIComponent(pub)}`, { headers: headers() });
                    if (!res.ok) throw new Error('Ошибка загрузки');
                    const blob = await res.blob();

                    // Получаем имя файла из Content-Disposition (если сервер его отдал)
                    let filename = 'client.conf';
                    const cd = res.headers.get('Content-Disposition');
                    if (cd && cd.includes('filename=')) {
                        filename = cd.split('filename=')[1].replace(/["']/g, '');
                        filename = decodeURIComponent(filename);
                    }

                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    return;
                }

                if (act === 'qr') {
                    // получаем QR PNG и показываем прямо в модалке
                    const res = await fetch(`/api/qr?pub=${encodeURIComponent(pub)}`, { headers: headers() });
                    if (!res.ok) throw new Error('Ошибка QR');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const overlay = document.createElement('div');
                    overlay.className = 'fixed inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center';
                    overlay.innerHTML = `
          <div class="bg-gray-800 p-4 rounded text-center">
            <h2 class="text-lg mb-3 font-semibold">📱 QR код клиента</h2>
            <img src="${url}" class="mx-auto border-4 border-gray-700 rounded-lg" />
            <button class="mt-4 bg-red-700 px-4 py-2 rounded">Закрыть</button>
          </div>`;
                    overlay.querySelector('button').onclick = () => overlay.remove();
                    document.body.appendChild(overlay);
                    return;
                }

                await api('/api/' + act, { method: 'POST', body: JSON.stringify({ pub }) });
            } catch (e) {
                if (e.message === 'unauthorized') return showLogin();
                alert('Ошибка: ' + e.message);
            }
        };
    });
}

socket.on('status', (s) => { $status.textContent = s.text; });
socket.on('peers', (peers) => { peersCache = peers; render(peersCache); });

$add.onclick = async () => {
    const name = ($name.value || '').trim();
    if (!name) return alert('Введите имя');
    try {
        await api('/api/add', { method: 'POST', body: JSON.stringify({ name }) });
        $name.value = '';
    } catch (e) {
        if (e.message === 'unauthorized') return showLogin();
        alert('Ошибка: ' + e.message);
    }
};

$refresh.onclick = async () => {
    try {
        const ps = await api('/api/peers');
        peersCache = ps; render(peersCache);
        const s = await api('/api/status');
        $status.textContent = s.iface;
    } catch (e) {
        if (e.message === 'unauthorized') return showLogin();
        alert('Ошибка: ' + e.message);
    }
};

$restart.onclick = async () => {
    if (!confirm('Перезапустить интерфейс WireGuard?')) return;
    try { await api('/api/restart', { method: 'POST' }); }
    catch (e) {
        if (e.message === 'unauthorized') return showLogin();
        alert('Ошибка: ' + e.message);
    }
};

$search.oninput = () => render(peersCache);

// форма логина
function showLogin() {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 flex flex-col items-center justify-center backdrop-blur-md bg-black bg-opacity-100 transition';
    overlay.innerHTML = `
    <div class="bg-gray-900 bg-opacity-95 p-6 rounded-2xl shadow-lg border border-gray-700 w-80 space-y-3 text-center">
      <h2 class="text-lg font-semibold">🔐 Авторизация</h2>
      <input id="lg-user" class="w-full bg-gray-900 p-2 rounded" placeholder="Логин">
      <input id="lg-pass" type="password" class="w-full bg-gray-900 p-2 rounded" placeholder="Пароль">
      <button id="lg-ok" class="bg-green-700 px-4 py-2 rounded w-full">Войти</button>
    </div>
  `;
    document.body.appendChild(overlay);
    const $user = overlay.querySelector('#lg-user');
    const $pass = overlay.querySelector('#lg-pass');
    overlay.querySelector('#lg-ok').onclick = async () => {
        const u = $user.value.trim();
        const p = $pass.value.trim();
        if (!u || !p) return alert('Введите логин и пароль');
        setAuth(u, p);
        document.body.removeChild(overlay);
        $refresh.click();
    };
}

// автоподключение, если логин сохранён
const savedUser = localStorage.getItem('WG_USER');
const savedPass = localStorage.getItem('WG_PASS');
if (savedUser && savedPass) {
    setAuth(savedUser, savedPass);
    $refresh.click();
} else {
    showLogin();
}

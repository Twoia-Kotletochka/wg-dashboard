# ⚙️ WireGuard Dashboard (Self-Hosted)

**WireGuard Dashboard** — лёгкая самодостаточная панель управления WireGuard-сервером на Node.js.  
Без внешних баз данных, без Docker-зависимостей — только `wg`, `node`, и полный контроль над вашим VPN.

---

## 🚀 Возможности

- 🔧 Добавление, удаление и блокировка клиентов  
- 🔑 Генерация `.conf`-файлов и QR-кодов  
- 📊 Отображение IP, трафика и времени последнего handshake  
- 🔒 Поддержка **Pre-Shared Key (PSK)** для дополнительной безопасности  
- ⚡ Обновление статистики в реальном времени (через Socket.IO)  
- 🧱 IP-whitelist и Basic-Auth защита  
- 🧾 Совместимо с любой существующей конфигурацией `wg0.conf`

---

## 🧩 Требования

Перед установкой убедитесь, что на сервере есть:

| Компонент | Версия | Установка |
|------------|---------|-----------|
| **Node.js** | ≥ 18 | `apt install nodejs npm` |
| **WireGuard** | ≥ 1.0 | `apt install wireguard` |
| **qrencode** | — | `apt install qrencode` |
| **pm2** *(опционально)* | — | `npm install -g pm2` |

---

## ⚙️ Установка

```bash
# 1. Перейдите в /opt и клонируйте репозиторий
cd /opt
git clone https://github.com/Twoia-Kotletochka/wg-dashboard-.git
cd wg-dashboard

# 2. Установите зависимости
npm install

# 3. Настройте окружение
cp .env.example .env
nano .env

# 4. Запуск панели
node server.js
# или через PM2:
pm2 start server.js --name wg-dashboard


🔧 Пример .env

WG_IF=wg0
WG_CONF=/etc/wireguard/wg0.conf
WG_SERVER_PUB=<публичный_ключ_сервера>
WG_ENDPOINT=<ваш_сервер>:51820
WG_DNS=1.1.1.1,8.8.8.8
WG_NET=10.0.70.0/24

PORT=54763
ADMIN_USER=admin
ADMIN_PASS=StrongPassword123

🔐 Безопасность

Панель по умолчанию защищена:

Basic-Auth — логин/пароль из .env

IP-фильтрация — разрешены только локальные и VPN-адреса

// server.js
app.use((req, res, next) => {
  const allowed = [
    '127.0.0.1', '::1',         // localhost
    '10.0.70.',                 // весь VPN диапазон
    '<твой_ип>'
  ];

  const ip = req.ip.replace('::ffff:', '');
  if (!allowed.some(a => ip.startsWith(a))) {
    console.warn(`🚫 Access denied from ${ip}`);
    return res.status(403).send('Forbidden');
  }
  next();
});

🧩 Пример конфигурации сервера
[Interface]
Address = 10.0.70.1/24
ListenPort = 51820
PrivateKey = <server_private_key>

# Разрешаем маршрутизацию и NAT
PostUp = sysctl -w net.ipv4.ip_forward=1
PostDown = sysctl -w net.ipv4.ip_forward=0
PostUp = iptables -t nat -A POSTROUTING -s 10.0.70.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s 10.0.70.0/24 -o eth0 -j MASQUERADE
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT
PostDown = iptables -D FORWARD -o wg0 -j ACCEPT

🛠 Автозапуск через PM2
pm2 startup
pm2 save
pm2 restart wg-dashboard

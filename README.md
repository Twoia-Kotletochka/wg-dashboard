# WireGuard Dashboard

Простая self-hosted панель для управления WireGuard-клиентами: создание, блокировка, удаление, выгрузка `.conf`, QR-коды и live-статистика.

## Что умеет
- Добавление/удаление клиентов.
- Блокировка/разблокировка peer.
- Скачивание клиентского `.conf`.
- Генерация QR-кода для мобильного подключения.
- Просмотр handshake/трафика в реальном времени.

---

## Быстрый старт (рекомендуется)

### 1) Подготовьте сервер (WireGuard + системные настройки)

```bash
cd /opt
git clone https://github.com/Twoia-Kotletochka/wg-dashboard-.git wg-dashboard
cd wg-dashboard

# Если WAN интерфейс не определяется автоматически, укажите вручную:
# sudo WAN_IF=eth0 WG_IF=wg0 WG_NET=10.0.70.0/24 bash scripts/preinstall-wg.sh
sudo bash scripts/preinstall-wg.sh
```

Скрипт `scripts/preinstall-wg.sh`:
- ставит `wireguard`, `qrencode`, `curl`, `git`;
- проверяет наличие `node`/`npm` и ставит их только при необходимости;
- включает `net.ipv4.ip_forward=1`;
- добавляет NAT (MASQUERADE) для сети WG;
- включает автозапуск `wg-quick@wg0`.

### 2) Установите зависимости панели

```bash
npm install
```

### 3) Настройте `.env` (файл теперь есть в репозитории)

```bash
cp .env.example .env
nano .env
```

Файл `.env.example` уже содержит рабочий шаблон. Минимальный пример:

```env
WG_IF=wg0
WG_CONF=/etc/wireguard/wg0.conf
WG_SERVER_PUB=<PUBLIC_KEY_СЕРВЕРА>
WG_ENDPOINT=<IP_ИЛИ_ДОМЕН>:51820
WG_DNS=1.1.1.1,8.8.8.8
WG_NET=10.0.70.0/24

PORT=54763
ADMIN_USER=admin
ADMIN_PASS=StrongPassword123

# Необязательно: белый список внешних IP
ALLOWED_IPS=203.0.113.10,198.51.100.7
```

### 4) Запуск

```bash
node server.js
```

Откройте: `http://<server-ip>:54763`

---

## Запуск как сервис (pm2)

```bash
sudo npm i -g pm2
pm2 start server.js --name wg-dashboard
pm2 save
pm2 startup
```

---

## Важные замечания

1. Перед запуском панели должен существовать и работать `/etc/wireguard/wg0.conf` (или ваш `WG_IF`).
2. Панель использует Basic Auth (`ADMIN_USER/ADMIN_PASS`).
3. Доступ к API ограничен localhost, подсетью `WG_NET` и IP из `ALLOWED_IPS`.
4. Для генерации QR требуется `qrencode`.


> Примечание: если у вас Node.js из NodeSource, `npm` часто уже встроен. Скрипт не форсирует `apt install npm`, чтобы избежать конфликта `nodejs Conflicts: npm`.

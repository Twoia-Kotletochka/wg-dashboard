# WireGuard Dashboard

Веб-панель для управления клиентами WireGuard на собственном сервере. Проект помогает быстро создавать VPN-клиентов, скачивать для них `.conf`, показывать QR-коды, блокировать или удалять доступ и смотреть базовую статистику подключений.

## Основные возможности

- Создание WireGuard-клиентов из веб-интерфейса.
- Скачивание клиентского `.conf` и генерация QR-кода.
- Блокировка, разблокировка и удаление клиентов.
- Live-статистика по handshake, трафику и скорости.
- Защита панели через Basic Auth.
- Автовход после перезагрузки страницы через `HttpOnly` session cookie без хранения пароля в `sessionStorage`.
- Ограничение доступа по IP: localhost, VPN-сеть и дополнительные IP/CIDR из `ALLOWED_IPS`.
- Хранение runtime-данных вне git: `data/peers.json` и `data/clients/*.conf`.

## Технологии

- Node.js 18.18+
- Express 5
- Socket.IO
- WireGuard CLI: `wg`, `wg-quick`
- `qrencode` для генерации QR-кодов
- Чистый HTML/CSS/JavaScript без frontend-сборщика

## Требования

- Linux-сервер с WireGuard.
- Node.js версии `18.18.0` или новее.
- `qrencode` для QR-кодов.
- Доступ к серверу с правами `sudo` для установки WireGuard и настройки интерфейса.
- Открытый UDP-порт WireGuard, обычно `51820`.
- HTTPS или доступ только через приватную сеть/VPN для production.
- Для локальной разработки WireGuard не обязателен, если использовать `AUTO_START_WG=false`.

## Установка на сервер

```bash
cd /opt
git clone https://github.com/Twoia-Kotletochka/wg-dashboard.git wg-dashboard
cd wg-dashboard
```

Подготовьте сервер:

```bash
sudo bash scripts/preinstall-wg.sh
```

Если WAN-интерфейс не определяется автоматически, укажите его вручную:

```bash
sudo WAN_IF=eth0 WG_IF=wg0 WG_NET=10.0.70.0/24 bash scripts/preinstall-wg.sh
```

Скрипт делает полный базовый bootstrap WireGuard:

- устанавливает `wireguard`, `qrencode`, `iptables`, `iproute2`, `curl`, `git`;
- генерирует server private/public key, если ключей ещё нет;
- создаёт `/etc/wireguard/wg0.conf`, если конфига ещё нет;
- добавляет `PostUp`/`PostDown` NAT в WireGuard config;
- включает IPv4 forwarding;
- включает автозапуск и сразу запускает `wg-quick@wg0`;
- проверяет, что интерфейс реально появился через `wg show wg0`;
- выводит готовые значения `WG_SERVER_PUB`, `WG_CONF`, `WG_ENDPOINT` и `WG_NET` для `.env`.

Если `/etc/wireguard/wg0.conf` уже существует, скрипт не перезаписывает его. В этом случае проверьте, что в конфиге есть `PostUp`/`PostDown` для NAT.

Установите зависимости и создайте `.env`:

```bash
npm ci
cp .env.example .env
nano .env
```

## Настройка `.env`

Минимальный рабочий пример:

```env
WG_IF=wg0
WG_CONF=/etc/wireguard/wg0.conf
WG_SERVER_PUB=<PUBLIC_KEY_ИЗ_ВЫВОДА_PREINSTALL>
WG_ENDPOINT=<IP_ИЛИ_ДОМЕН>:51820
WG_DNS=1.1.1.1,8.8.8.8
WG_NET=10.0.70.0/24
PORT=54763
HOST=127.0.0.1
PUBLIC_URL=https://vpn.example.com/wg-easy
AUTO_START_WG=true
ADMIN_USER=admin
ADMIN_PASS=StrongPassword123
ALLOWED_IPS=
BASE_DIR=/opt/wg-dashboard
```

Файл `.env.example` уже есть в проекте. Его можно использовать как шаблон:

```bash
cp .env.example .env
```

Основные переменные:

| Переменная | Назначение |
| --- | --- |
| `WG_IF` | Имя WireGuard-интерфейса, обычно `wg0`. |
| `WG_CONF` | Путь к конфигу WireGuard, обычно `/etc/wireguard/wg0.conf`. |
| `WG_SERVER_PUB` | Public key WireGuard-сервера для клиентских конфигов. Скрипт `scripts/preinstall-wg.sh` выводит это значение после генерации ключей. |
| `WG_ENDPOINT` | Публичный адрес сервера в формате `host:port`. |
| `WG_DNS` | DNS-серверы, которые будут прописаны клиентам. |
| `WG_NET` | VPN-подсеть, из которой выдаются IP клиентов. |
| `PORT` | HTTP-порт веб-панели. |
| `HOST` | IP, на котором слушает Node.js. Для Caddy/nginx используйте `127.0.0.1`, чтобы порт не был открыт напрямую наружу. |
| `PUBLIC_URL` | Внешний адрес панели, например `https://vpn.example.com/wg-easy`. Путь из URL используется для assets, API и Socket.IO. |
| `PUBLIC_BASE_PATH` | Явный путь публикации, например `/wg-easy`. Обычно не нужен, если заполнен `PUBLIC_URL`. |
| `AUTO_START_WG` | `true` поднимает WireGuard при старте приложения, `false` удобно для локальной разработки. |
| `ADMIN_USER` / `ADMIN_PASS` | Логин и пароль для входа в панель. |
| `ALLOWED_IPS` | Дополнительные разрешённые IP или CIDR через запятую. |
| `BASE_DIR` | Каталог для runtime-данных приложения. |

## Запуск локально

Для локальной проверки UI и API без установленного WireGuard:

```bash
npm ci
AUTO_START_WG=false BASE_DIR="$(pwd)/.runtime" ADMIN_USER=admin ADMIN_PASS=admin npm start
```

Откройте:

```text
http://127.0.0.1:54763
```

Войдите с логином и паролем из переменных `ADMIN_USER` и `ADMIN_PASS`.

## Запуск на сервере

```bash
npm start
```

После запуска откройте:

```text
https://vpn.example.com/wg-easy
```

В production Node.js должен слушать только `127.0.0.1`, а внешний доступ должен идти через HTTPS reverse proxy. Для этого оставьте `HOST=127.0.0.1` и укажите внешний адрес в `PUBLIC_URL`, например `https://vpn.example.com/wg-easy`.

## HTTPS через Caddy и путь `/wg-easy`

Если на сервере уже запущен Caddy для другого сервиса, не поднимайте nginx на тех же `80/443`. Оставьте Caddy главным reverse proxy и добавьте отдельный маршрут для панели:

```caddy
your-subdomain.duckdns.org {
    encode zstd gzip

    @wg path /wg-easy /wg-easy/*
    handle @wg {
        reverse_proxy 127.0.0.1:54763
    }

    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Пример `.env` для DuckDNS-домена:

```env
HOST=127.0.0.1
PORT=54763
PUBLIC_URL=https://your-subdomain.duckdns.org/wg-easy
WG_ENDPOINT=your-subdomain.duckdns.org:51820
```

После изменения Caddyfile:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl restart wg-dashboard
```

Порт Node.js `54763` не нужно открывать наружу. Caddy принимает HTTPS на `443` и ходит к панели локально через `127.0.0.1`.

## Деплой через pm2

```bash
sudo npm i -g pm2
pm2 start server.js --name wg-dashboard
pm2 save
pm2 startup
```

После обновления кода:

```bash
git pull
npm ci
pm2 restart wg-dashboard
```

`pm2 restart` перезапускает только веб-панель. Кнопка "Перезапустить WG" внутри панели выполняет `wg-quick down` и `wg-quick up`, поэтому временно обрывает активные WireGuard-соединения.

## HTTPS через nginx и путь `/wg-easy`

Пример `.env` для панели на `https://vpn.example.com/wg-easy`:

```env
HOST=127.0.0.1
PORT=54763
PUBLIC_URL=https://vpn.example.com/wg-easy
```

Минимальный пример reverse proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name vpn.example.com;

    ssl_certificate /etc/letsencrypt/live/vpn.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vpn.example.com/privkey.pem;

    location = /wg-easy {
        return 308 /wg-easy/;
    }

    location /wg-easy/ {
        proxy_pass http://127.0.0.1:54763;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

При такой схеме порт `54763` не должен быть открыт во внешний интернет. Nginx ходит к Node.js локально, поэтому пустой `ALLOWED_IPS` уже пропускает запросы от `127.0.0.1`. Если вы всё же слушаете на `0.0.0.0` и открываете порт напрямую, для доступа с любых IPv4 нужно `ALLOWED_IPS=0.0.0.0/0`, но это хуже для production.

## Как пользоваться

1. Откройте веб-панель и войдите по логину и паролю.
2. Введите имя нового клиента. Допустимы латинские буквы, цифры, точка, подчёркивание и дефис.
3. Нажмите кнопку добавления клиента.
4. Скачайте `.conf` или откройте QR-код для настройки WireGuard-клиента.
5. При необходимости заблокируйте, разблокируйте или удалите клиента из списка.
6. После ручных изменений WireGuard-конфига используйте кнопку перезапуска интерфейса.

## Проверки и сборка

```bash
npm run check
npm run lint
npm test
npm run build
npm run smoke
npm run verify
```

Что делают команды:

| Команда | Назначение |
| --- | --- |
| `npm run check` | Проверяет синтаксис JavaScript-файлов через `node --check`. |
| `npm run lint` | Запускает ESLint. |
| `npm test` | Запускает unit-тесты через `node:test`. |
| `npm run build` | Выполняет статическую build-проверку проекта. |
| `npm run smoke` | Проверяет локальный HTTP-запуск без WireGuard. |
| `npm run verify` | Запускает lint, tests, build и smoke подряд. |
| `npm audit` | Проверяет зависимости на известные уязвимости. |

В проекте нет frontend-бандлера: интерфейс лежит в `public/` и отдаётся как статические файлы. Поэтому `build` здесь означает проверку проекта, а не генерацию отдельной папки `dist`.

## Структура проекта

```text
server.js                 # Express/Socket.IO entrypoint
src/config.js             # чтение и валидация env-настроек
src/auth.js               # Basic Auth helpers
src/net.js                # IP/CIDR helpers и выбор следующего client IP
src/storage.js            # работа с peers.json и client config files
src/wireguard.js          # безопасная обёртка над wg, wg-quick и qrencode
src/mutation-queue.js     # сериализация операций, меняющих peers.json и wg config
public/index.html         # разметка веб-панели
public/styles.css         # стили интерфейса
public/app.js             # клиентская логика панели
scripts/preinstall-wg.sh  # подготовка сервера и WireGuard
scripts/check-js.js       # проверка синтаксиса JS-файлов
scripts/smoke.js          # smoke test локального HTTP-сервера
test/                     # unit-тесты
```

## Формат `data/peers.json`

Файл создаётся автоматически в `BASE_DIR/data/peers.json` и не хранится в git. Пример записи:

```json
{
  "name": "admin-phone",
  "ip": "10.0.70.2",
  "pub": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
  "created": 1710000000000,
  "blocked": false
}
```

Поля:

| Поле | Назначение |
| --- | --- |
| `name` | Имя клиента, используется также для имени `.conf` файла. |
| `ip` | IP клиента внутри VPN-сети. |
| `pub` | WireGuard public key клиента. |
| `created` | Время создания в Unix timestamp milliseconds. |
| `blocked` | Признак блокировки клиента в панели. |

## Частые ошибки

### `wg не найден`

WireGuard CLI не установлен или приложение запущено не на сервере. Для локальной проверки используйте:

```bash
AUTO_START_WG=false npm start
```

На сервере установите WireGuard через `scripts/preinstall-wg.sh`.

### `Forbidden`

Ваш IP не входит в список разрешённых. Доступ разрешён с localhost, из VPN-подсети `WG_NET` и из адресов `ALLOWED_IPS`.

Пример:

```env
ALLOWED_IPS=203.0.113.10,192.168.1.0/24
```

### Не подходит логин или пароль

Проверьте `ADMIN_USER` и `ADMIN_PASS` в `.env`, затем перезапустите приложение.

### QR-код не генерируется

На сервере должен быть установлен `qrencode`. Обычно он устанавливается скриптом `scripts/preinstall-wg.sh`.

### Клиент не подключается

Проверьте:

- корректность `WG_ENDPOINT`;
- открыт ли UDP-порт WireGuard;
- совпадает ли `WG_SERVER_PUB` с public key сервера;
- не заблокирован ли peer в панели;
- поднят ли интерфейс `wg0`.

## Runtime-данные и безопасность

- Не коммитьте `.env`, `data/peers.json`, `data/clients/*.conf` и `.runtime/`.
- Используйте сильный пароль в `ADMIN_PASS`.
- Не открывайте панель на весь интернет без HTTPS и дополнительной сетевой защиты.
- Ограничивайте доступ через `ALLOWED_IPS`, VPN или firewall.
- Клиентские `.conf` содержат приватные ключи, поэтому храните их как секреты.
- После успешного входа сервер ставит `HttpOnly` cookie для автологина; пароль не хранится в `localStorage` или `sessionStorage`.
- Сессии хранятся в памяти процесса 12 часов. После перезапуска панели нужно войти снова.
- Приложение добавляет базовые security headers: CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`.

## Полезные команды

```bash
npm start
npm run verify
npm audit
sudo systemctl status wg-quick@wg0
sudo wg show wg0
pm2 logs wg-dashboard
pm2 restart wg-dashboard
```

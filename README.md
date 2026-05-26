# WireGuard Dashboard

Веб-панель для управления клиентами WireGuard на собственном сервере. Проект помогает быстро создавать VPN-клиентов, скачивать для них `.conf`, показывать QR-коды, блокировать или удалять доступ и смотреть базовую статистику подключений.

## Основные возможности

- Создание WireGuard-клиентов из веб-интерфейса.
- Скачивание клиентского `.conf` и генерация QR-кода.
- Блокировка, разблокировка и удаление клиентов.
- Live-статистика по handshake, трафику и скорости.
- Защита панели через Basic Auth.
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
- Доступ к серверу с правами `sudo` для установки WireGuard и настройки интерфейса.
- Открытый UDP-порт WireGuard, обычно `51820`.
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
WG_SERVER_PUB=<PUBLIC_KEY_СЕРВЕРА>
WG_ENDPOINT=<IP_ИЛИ_ДОМЕН>:51820
WG_DNS=1.1.1.1,8.8.8.8
WG_NET=10.0.70.0/24
PORT=54763
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
| `WG_SERVER_PUB` | Public key WireGuard-сервера для клиентских конфигов. |
| `WG_ENDPOINT` | Публичный адрес сервера в формате `host:port`. |
| `WG_DNS` | DNS-серверы, которые будут прописаны клиентам. |
| `WG_NET` | VPN-подсеть, из которой выдаются IP клиентов. |
| `PORT` | HTTP-порт веб-панели. |
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
http://<server-ip>:54763
```

В production лучше запускать приложение через process manager.

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
public/index.html         # разметка веб-панели
public/styles.css         # стили интерфейса
public/app.js             # клиентская логика панели
scripts/preinstall-wg.sh  # подготовка сервера и WireGuard
scripts/check-js.js       # проверка синтаксиса JS-файлов
scripts/smoke.js          # smoke test локального HTTP-сервера
test/                     # unit-тесты
```

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
- Не открывайте панель на весь интернет без дополнительной сетевой защиты.
- Ограничивайте доступ через `ALLOWED_IPS`, VPN или firewall.
- Клиентские `.conf` содержат приватные ключи, поэтому храните их как секреты.

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

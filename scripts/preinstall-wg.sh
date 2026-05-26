#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "[!] Запустите скрипт от root: sudo bash $0" >&2
  exit 1
fi

WG_IF="${WG_IF:-wg0}"
WG_NET="${WG_NET:-10.0.70.0/24}"
WG_PORT="${WG_PORT:-51820}"
WG_CONF="${WG_CONF:-/etc/wireguard/${WG_IF}.conf}"
WG_DIR="$(dirname "${WG_CONF}")"
WG_PRIVATE_KEY_FILE="${WG_PRIVATE_KEY_FILE:-${WG_DIR}/${WG_IF}.key}"
WG_PUBLIC_KEY_FILE="${WG_PUBLIC_KEY_FILE:-${WG_DIR}/${WG_IF}.pub}"
WAN_IF="${WAN_IF:-}"
MIN_NODE_MAJOR=18
MIN_NODE_MINOR=18

echo "[+] Обновляем индексы пакетов"
apt-get update

echo "[+] Установка пакетов: wireguard, qrencode, curl, git, iptables, iproute2"
apt-get install -y wireguard qrencode curl git iptables iproute2

if [[ -z "${WAN_IF}" ]]; then
  WAN_IF="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
fi

if [[ -z "${WAN_IF}" ]]; then
  echo "[!] Не удалось определить WAN интерфейс. Укажите вручную: WAN_IF=eth0 bash $0" >&2
  exit 1
fi

require_command() {
  local command="$1"
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[!] Команда ${command} не найдена после установки пакетов." >&2
    exit 1
  fi
}

for command in wg wg-quick qrencode ip iptables; do
  require_command "${command}"
done

check_node_version() {
  local version major minor
  version="$(node --version 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"

  if [[ -z "${major}" || -z "${minor}" ]]; then
    return 1
  fi

  if (( major > MIN_NODE_MAJOR )); then
    return 0
  fi

  if (( major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR )); then
    return 0
  fi

  return 1
}

if command -v node >/dev/null 2>&1; then
  echo "[+] Node.js уже установлен: $(node --version)"
else
  echo "[+] Установка Node.js из системного репозитория"
  apt-get install -y nodejs
fi

if ! check_node_version; then
  echo "[!] Требуется Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+." >&2
  echo "[!] Установите актуальный Node.js (например, из NodeSource) и повторите запуск." >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  echo "[+] npm уже установлен: $(npm --version)"
else
  echo "[+] npm не найден, пробуем установить отдельно"
  apt-get install -y npm || {
    echo "[!] Не удалось установить npm через apt (возможен конфликт с NodeSource nodejs)." >&2
    echo "[!] Установите npm совместимым способом для вашей Node.js-сборки и повторите запуск панели." >&2
    exit 1
  }
fi

ipv4_to_int() {
  local ip="$1" a b c d
  IFS=. read -r a b c d <<<"${ip}"
  for octet in "${a}" "${b}" "${c}" "${d}"; do
    if [[ ! "${octet}" =~ ^[0-9]{1,3}$ ]] || (( octet < 0 || octet > 255 )); then
      echo "[!] Некорректный IPv4 адрес: ${ip}" >&2
      exit 1
    fi
  done
  echo $(( (a << 24) + (b << 16) + (c << 8) + d ))
}

int_to_ipv4() {
  local value="$1"
  printf '%d.%d.%d.%d' \
    $(( (value >> 24) & 255 )) \
    $(( (value >> 16) & 255 )) \
    $(( (value >> 8) & 255 )) \
    $(( value & 255 ))
}

server_ip_from_cidr() {
  local cidr="$1" ip prefix ip_int mask network
  if [[ "${cidr}" != */* ]]; then
    echo "[!] WG_NET должен быть CIDR, например 10.0.70.0/24" >&2
    exit 1
  fi

  ip="${cidr%/*}"
  prefix="${cidr#*/}"
  if [[ ! "${prefix}" =~ ^[0-9]{1,2}$ ]] || (( prefix < 0 || prefix > 30 )); then
    echo "[!] WG_NET должен иметь пригодный IPv4 prefix /0../30: ${cidr}" >&2
    exit 1
  fi

  ip_int="$(ipv4_to_int "${ip}")"
  if (( prefix == 0 )); then
    mask=0
  else
    mask=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
  fi
  network=$(( ip_int & mask ))
  int_to_ipv4 $(( network + 1 ))
}

extract_private_key_from_conf() {
  local file="$1"
  awk '
    /^[[:space:]]*PrivateKey[[:space:]]*=/ {
      line = $0;
      sub(/^[^=]*=[[:space:]]*/, "", line);
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line);
      print line;
      exit;
    }
  ' "${file}" 2>/dev/null || true
}

ensure_server_keys() {
  local existing_private
  install -d -m 700 "${WG_DIR}"

  existing_private=""
  if [[ -s "${WG_CONF}" ]]; then
    existing_private="$(extract_private_key_from_conf "${WG_CONF}")"
  fi

  if [[ -s "${WG_CONF}" && -z "${existing_private}" ]]; then
    echo "[!] В существующем ${WG_CONF} не найден PrivateKey." >&2
    echo "[!] Исправьте конфиг вручную или удалите его, чтобы скрипт создал новый." >&2
    exit 1
  elif [[ -n "${existing_private}" ]]; then
    printf '%s\n' "${existing_private}" >"${WG_PRIVATE_KEY_FILE}"
    chmod 600 "${WG_PRIVATE_KEY_FILE}"
  elif [[ ! -s "${WG_PRIVATE_KEY_FILE}" ]]; then
    echo "[+] Генерируем серверный private key: ${WG_PRIVATE_KEY_FILE}"
    umask 077
    wg genkey >"${WG_PRIVATE_KEY_FILE}"
    chmod 600 "${WG_PRIVATE_KEY_FILE}"
  fi

  if [[ ! -s "${WG_PRIVATE_KEY_FILE}" ]]; then
    echo "[!] Не удалось получить server private key для ${WG_IF}" >&2
    exit 1
  fi

  wg pubkey <"${WG_PRIVATE_KEY_FILE}" >"${WG_PUBLIC_KEY_FILE}"
  chmod 644 "${WG_PUBLIC_KEY_FILE}"
}

write_wireguard_config() {
  local server_ip prefix private_key
  server_ip="$(server_ip_from_cidr "${WG_NET}")"
  prefix="${WG_NET#*/}"
  private_key="$(cat "${WG_PRIVATE_KEY_FILE}")"

  if [[ -s "${WG_CONF}" ]]; then
    echo "[+] WireGuard config уже существует, не перезаписываем: ${WG_CONF}"
    return
  fi

  echo "[+] Создаём WireGuard config: ${WG_CONF}"
  cat >"${WG_CONF}" <<WGCONF
[Interface]
Address = ${server_ip}/${prefix}
ListenPort = ${WG_PORT}
PrivateKey = ${private_key}
PostUp = iptables -t nat -C POSTROUTING -s ${WG_NET} -o ${WAN_IF} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${WG_NET} -o ${WAN_IF} -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s ${WG_NET} -o ${WAN_IF} -j MASQUERADE 2>/dev/null || true
WGCONF
  chmod 600 "${WG_CONF}"
}

echo "[+] Включаем IPv4 forwarding"
cat >/etc/sysctl.d/99-wireguard-forward.conf <<SYSCTL
net.ipv4.ip_forward=1
SYSCTL
sysctl --system >/dev/null

ensure_server_keys
write_wireguard_config

if grep -q '^[[:space:]]*PostUp[[:space:]]*=' "${WG_CONF}"; then
  echo "[+] NAT будет применяться через PostUp/PostDown в ${WG_CONF}"
else
  echo "[!] В существующем ${WG_CONF} не найден PostUp/PostDown NAT." >&2
  echo "[!] Добавьте MASQUERADE вручную или пересоздайте конфиг скриптом." >&2
fi

echo "[+] Включаем автозапуск и запускаем WireGuard интерфейс ${WG_IF}"
if wg show "${WG_IF}" >/dev/null 2>&1; then
  echo "[+] Интерфейс ${WG_IF} уже запущен"
elif [[ "${WG_CONF}" == "/etc/wireguard/${WG_IF}.conf" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl enable "wg-quick@${WG_IF}"
  if ! systemctl start "wg-quick@${WG_IF}"; then
    echo "[!] Не удалось запустить wg-quick@${WG_IF}. Последние логи:" >&2
    journalctl -u "wg-quick@${WG_IF}" -n 50 --no-pager >&2 || true
    exit 1
  fi
else
  if ! wg-quick up "${WG_CONF}"; then
    echo "[!] Не удалось запустить WireGuard через wg-quick up ${WG_CONF}" >&2
    exit 1
  fi
fi

if ! wg show "${WG_IF}" >/dev/null 2>&1; then
  echo "[!] WireGuard interface ${WG_IF} не появился после запуска." >&2
  exit 1
fi

SERVER_PUB="$(cat "${WG_PUBLIC_KEY_FILE}")"

cat <<DONE
[✓] WireGuard готов.

Config: ${WG_CONF}
Interface: ${WG_IF}
VPN network: ${WG_NET}
WAN interface: ${WAN_IF}

Добавьте в .env:
WG_IF=${WG_IF}
WG_CONF=${WG_CONF}
WG_SERVER_PUB=${SERVER_PUB}
WG_ENDPOINT=<IP_ИЛИ_ДОМЕН>:${WG_PORT}
WG_NET=${WG_NET}
DONE

#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "[!] Запустите скрипт от root: sudo bash $0" >&2
  exit 1
fi

WG_IF="${WG_IF:-wg0}"
WG_NET="${WG_NET:-10.0.70.0/24}"
WAN_IF="${WAN_IF:-$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')}"

if [[ -z "${WAN_IF}" ]]; then
  echo "[!] Не удалось определить WAN интерфейс. Укажите вручную: WAN_IF=eth0 bash $0" >&2
  exit 1
fi

echo "[+] Обновляем индексы пакетов"
apt-get update

echo "[+] Установка пакетов: wireguard, qrencode, curl, git"
apt-get install -y wireguard qrencode curl git

if command -v node >/dev/null 2>&1; then
  echo "[+] Node.js уже установлен: $(node --version)"
else
  echo "[+] Установка Node.js из системного репозитория"
  apt-get install -y nodejs
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

echo "[+] Включаем IPv4 forwarding"
cat >/etc/sysctl.d/99-wireguard-forward.conf <<SYSCTL
net.ipv4.ip_forward=1
SYSCTL
sysctl --system >/dev/null

echo "[+] Применяем NAT для сети ${WG_NET} через ${WAN_IF}"
iptables -t nat -C POSTROUTING -s "${WG_NET}" -o "${WAN_IF}" -j MASQUERADE 2>/dev/null || \
iptables -t nat -A POSTROUTING -s "${WG_NET}" -o "${WAN_IF}" -j MASQUERADE

if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
elif command -v iptables-save >/dev/null 2>&1; then
  mkdir -p /etc/iptables
  iptables-save >/etc/iptables/rules.v4
fi

echo "[+] Включаем автозапуск WireGuard интерфейса ${WG_IF}"
systemctl enable "wg-quick@${WG_IF}" || true

echo "[✓] Готово. Проверьте /etc/wireguard/${WG_IF}.conf и запустите: systemctl start wg-quick@${WG_IF}"

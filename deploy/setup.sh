#!/usr/bin/env bash
# Тренер 24 — установка на чистый сервер Ubuntu 22.04/24.04.
# Запуск (от root):  curl -fsSL https://raw.githubusercontent.com/tima9753-cpu/trener24/main/deploy/setup.sh | bash
# Скрипт спросит домен, почту для SSL и токен бота. Токен вводится скрыто и хранится только на сервере.
set -euo pipefail
REPO="https://github.com/tima9753-cpu/trener24.git"
DIR=/opt/trener24
DATA=/var/lib/trener24
say(){ printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Запусти от root (sudo -i)"; exit 1; }
exec </dev/tty  # чтобы вопросы работали и при запуске через curl | bash

read -rp "Домен (например trener24app.ru): " DOMAIN
DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
read -rp "Почта для SSL-сертификата: " EMAIL
read -rsp "Токен бота от @BotFather (ввод скрыт): " BOT_TOKEN; echo
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] && [ -n "$BOT_TOKEN" ] || { echo "Нужны домен, почта и токен"; exit 1; }

say "Обновляю систему и ставлю пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx sqlite3 ufw ca-certificates build-essential
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Создаю пользователя и скачиваю код"
id trener24 >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin trener24
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
mkdir -p "$DATA"
cd "$DIR/server" && npm install --omit=dev --no-audit --no-fund

say "Пишу настройки (.env)"
umask 077
cat > "$DIR/server/.env" <<ENV
BOT_TOKEN=$BOT_TOKEN
APP_URL=https://$DOMAIN/app/
AI_PROXY=https://trener24.vercel.app/api/ai
CRON_SECRET=$(openssl rand -hex 24)
DB_PATH=$DATA/trener24.sqlite
PORT=3000
ENV
umask 022
chown -R trener24:trener24 "$DIR" "$DATA"
chmod 600 "$DIR/server/.env"

say "Запускаю службу"
cat > /etc/systemd/system/trener24.service <<UNIT
[Unit]
Description=Trener 24 (mini app, bot, database)
After=network-online.target
Wants=network-online.target
[Service]
User=trener24
WorkingDirectory=$DIR/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now trener24
sleep 2; curl -fsS http://127.0.0.1:3000/health && echo

say "Настраиваю nginx"
cat > /etc/nginx/sites-available/trener24 <<NGX
server {
  listen 80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 8m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 75s;
  }
}
NGX
ln -sf /etc/nginx/sites-available/trener24 /etc/nginx/sites-enabled/trener24
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

say "Файрвол"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

say "SSL-сертификат (домен уже должен указывать на этот сервер)"
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
  || certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

say "Ежедневная копия базы (хранится 14 дней)"
mkdir -p /var/backups/trener24
cat > /etc/cron.daily/trener24-backup <<'BAK'
#!/bin/sh
f=/var/backups/trener24/trener24-$(date +%F).sqlite
sqlite3 /var/lib/trener24/trener24.sqlite ".backup '$f'" && gzip -f "$f"
find /var/backups/trener24 -name '*.gz' -mtime +14 -delete
BAK
chmod +x /etc/cron.daily/trener24-backup

cat <<DONE

Готово. Проверь:
  https://$DOMAIN/          — страница с ценами
  https://$DOMAIN/app/      — приложение
  https://$DOMAIN/health    — состояние сервера

Перевести бота на этот сервер (сделай, когда страницы открываются):
  curl -s "https://$DOMAIN/api/bot?setup=1"
Обновление после изменений в коде:
  bash $DIR/deploy/update.sh
DONE

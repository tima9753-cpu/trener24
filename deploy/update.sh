#!/usr/bin/env bash
# Обновить код и перезапустить: bash /opt/trener24/deploy/update.sh
set -euo pipefail
cd /opt/trener24
sudo -u trener24 git pull --ff-only
cd server && sudo -u trener24 npm install --omit=dev --no-audit --no-fund
systemctl restart trener24
sleep 2 && curl -fsS http://127.0.0.1:3000/health && echo

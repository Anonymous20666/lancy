#!/usr/bin/env bash
set -euo pipefail

# Turnkey installer & PM2 launcher for a self-hosted Telegram Local Bot API Server
# Unlocks 2,000 MB (2 GB) bot uploads & downloads via TELEGRAM_API_BASE_URL.

ENV_FILE="${1:-$(pwd)/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" ]]; then
  echo "ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in $ENV_FILE" >&2
  exit 1
fi

PORT="${LOCAL_BOT_API_PORT:-8081}"
WORK_DIR="${LOCAL_BOT_API_DIR:-/var/lib/telegram-bot-api}"
mkdir -p "$WORK_DIR"

if ! command -v telegram-bot-api >/dev/null 2>&1; then
  echo "Installing dependencies and building/fetching telegram-bot-api..."
  if command -v docker >/dev/null 2>&1; then
    docker rm -f lancy-local-bot-api >/dev/null 2>&1 || true
    docker run -d \
      --name lancy-local-bot-api \
      --restart unless-stopped \
      -p "127.0.0.1:${PORT}:8081" \
      -v "${WORK_DIR}:${WORK_DIR}" \
      -e TELEGRAM_API_ID="${TELEGRAM_API_ID}" \
      -e TELEGRAM_API_HASH="${TELEGRAM_API_HASH}" \
      -e TELEGRAM_LOCAL=1 \
      aiogram/telegram-bot-api:latest \
      --local --dir="${WORK_DIR}" --http-port=8081
  else
    echo "Neither telegram-bot-api binary nor docker found. Install docker.io or telegram-bot-api first." >&2
    exit 1
  fi
else
  PM2_HOME="${PM2_HOME:-/data/pm2}" pm2 delete lancy-local-bot-api >/dev/null 2>&1 || true
  PM2_HOME="${PM2_HOME:-/data/pm2}" pm2 start telegram-bot-api \
    --name lancy-local-bot-api \
    -- \
    --local \
    --api-id="${TELEGRAM_API_ID}" \
    --api-hash="${TELEGRAM_API_HASH}" \
    --http-port="${PORT}" \
    --dir="${WORK_DIR}"
  PM2_HOME="${PM2_HOME:-/data/pm2}" pm2 save
fi

if [[ -f "$ENV_FILE" ]]; then
  grep -q '^TELEGRAM_API_BASE_URL=' "$ENV_FILE" \
    && sed -i "s|^TELEGRAM_API_BASE_URL=.*|TELEGRAM_API_BASE_URL=http://127.0.0.1:${PORT}|" "$ENV_FILE" \
    || echo "TELEGRAM_API_BASE_URL=http://127.0.0.1:${PORT}" >> "$ENV_FILE"
  grep -q '^TELEGRAM_UPLOAD_LIMIT_MB=' "$ENV_FILE" \
    && sed -i "s|^TELEGRAM_UPLOAD_LIMIT_MB=.*|TELEGRAM_UPLOAD_LIMIT_MB=2000|" "$ENV_FILE" \
    || echo "TELEGRAM_UPLOAD_LIMIT_MB=2000" >> "$ENV_FILE"
fi

echo "Local Bot API Server active on http://127.0.0.1:${PORT} (2000 MB upload limit enabled)."

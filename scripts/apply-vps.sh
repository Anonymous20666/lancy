#!/usr/bin/env bash
set -euo pipefail

cd /data/.gemini/antigravity-cli/scratch/lancy-production-play-card-repair-20261021
chmod +x scripts/setup-local-bot-api.sh

echo "=== 1. Stopping lancy-bot & stale voice daemon for live setup verification ==="
PM2_HOME=/data/pm2 pm2 stop lancy-bot || true
pkill -f "service/voice/main.py" || true
sleep 1

echo "=== 2. Verifying wildcard account sync & live VC setup on -1003949983275 ==="
set -a
source .env
set +a
node scripts/verify-live-vps.mjs

echo "=== 3. Restarting lancy-bot under PM2 ==="
pkill -f "service/voice/main.py" || true
PM2_HOME=/data/pm2 pm2 restart lancy-bot --update-env
sleep 3
PM2_HOME=/data/pm2 pm2 status lancy-bot

#!/usr/bin/env bash
# LeadPlatform 本地部署脚本（systemd --user + CLI 软链）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE=lead-platform.service
UNIT_DIR="$HOME/.config/systemd/user"
DATA_DIR="$HOME/.lead-platform"
HEALTH_URL="http://127.0.0.1:8793/v1/health"

echo "==> [1/7] 检查 .env"
if [ ! -f "$ROOT/.env" ]; then
  node "$ROOT/scripts/bootstrap-env.mjs"
fi
chmod 600 "$ROOT/.env" || true

echo "==> [2/7] 安装依赖"
if [ ! -d "$ROOT/node_modules" ]; then
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

echo "==> [3/7] 构建"
npm run build

echo "==> [4/7] 准备数据目录"
mkdir -p "$DATA_DIR" "$DATA_DIR/backups" "$DATA_DIR/archive" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR"
chmod +x "$ROOT/dist/cli.js"

echo "==> [5/7] 安装 systemd user unit"
mkdir -p "$UNIT_DIR"
cp "$ROOT/systemd/$SERVICE" "$UNIT_DIR/$SERVICE"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"

echo "==> [6/7] 安装 CLI 命令 lead"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/dist/cli.js" "$HOME/.local/bin/lead"
chmod +x "$ROOT/dist/cli.js"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "WARN: ~/.local/bin 不在 PATH 中；请把 export PATH=\"\$HOME/.local/bin:\$PATH\" 加到 ~/.bashrc" ;;
esac

echo "==> [7/7] 健康检查"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "OK: lead-platform 已启动：$HEALTH_URL"
    echo "    /docs:      http://127.0.0.1:8793/docs"
    echo "    openapi:    http://127.0.0.1:8793/openapi.json"
    echo "    CLI:        lead status"
    exit 0
  fi
  sleep 1
done

echo "ERROR: health check 超时，最近日志："
systemctl --user status "$SERVICE" --no-pager -l | tail -30 || true
journalctl --user -u "$SERVICE" -n 40 --no-pager || true
exit 1

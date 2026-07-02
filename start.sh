#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  SRC Agent - Starting Services"
echo "========================================"
echo ""

# Check .env
if [ ! -f "apps/server/.env" ]; then
  echo "[ERROR] apps/server/.env not found."
  echo "Please copy apps/server/.env.example to apps/server/.env and fill in your API key."
  exit 1
fi

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
  echo "[ERROR] pnpm is not installed or not in PATH."
  echo "Please install pnpm:  npm install -g pnpm"
  exit 1
fi

# Install dependencies from root if needed
if [ ! -f "apps/server/node_modules/.bin/tsx" ]; then
  echo "[WARN] Dependencies not found. Running pnpm install from root..."
  pnpm install --prefer-offline
fi

cleanup() {
  echo ""
  echo "Stopping services..."
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

# Start backend
echo "[1/2] Starting backend  → http://localhost:3001"
cd "$SCRIPT_DIR/apps/server"
node_modules/.bin/tsx src/index.ts &
BACKEND_PID=$!

sleep 2

# Start frontend
cd "$SCRIPT_DIR/apps/web"
if [ ! -d "node_modules" ]; then
  echo "[WARN] Frontend node_modules not found."
  echo "       Run:  pnpm install"
  echo ""
  echo "========================================"
  echo "  Backend:  http://localhost:3001 (running)"
  echo "  Frontend: NOT started (missing deps)"
  echo "========================================"
  wait "$BACKEND_PID"
else
  echo "[2/2] Starting frontend → http://localhost:5173"
  npm run dev &
  FRONTEND_PID=$!

  echo ""
  echo "========================================"
  echo "  Backend:  http://localhost:3001"
  echo "  Frontend: http://localhost:5173"
  echo "========================================"
  echo "  Press Ctrl+C to stop both services."
  echo "========================================"

  wait "$BACKEND_PID" "$FRONTEND_PID"
fi

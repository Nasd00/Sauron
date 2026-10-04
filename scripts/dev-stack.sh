#!/usr/bin/env bash
# Start Photon + ngrok + Iris web for local iOS / iMessage development.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PHOTON_PORT="${PHOTON_PORT:-3001}"
WEB_PORT="${WEB_PORT:-4173}"
IRIS_WEB_MODE="${IRIS_WEB_MODE:-preview}"
NGROK_HOST="${NGROK_HOST:-starfish-revolving-footman.ngrok-free.dev}"
export PHOTON_PORT NGROK_HOST
NGROK_URL="https://${NGROK_HOST}"
HEALTH_URL="${NGROK_URL}/health"

PIDS=()

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping stack…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Freeing port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

wait_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-40}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "✓ ${label}: ${url}"
      return 0
    fi
    sleep 0.5
  done
  echo "✗ ${label} did not become ready: ${url}" >&2
  return 1
}

echo "Starting Iris stack from ${ROOT}"
echo "  Photon  → :${PHOTON_PORT}"
echo "  ngrok   → ${NGROK_URL} → localhost:${WEB_PORT} (Iris + Photon proxy)"
echo "  Web     → http://127.0.0.1:${WEB_PORT}"
echo

command -v ngrok >/dev/null || { echo "ngrok is not on PATH. Install from https://ngrok.com/download" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is not on PATH" >&2; exit 1; }

free_port "$PHOTON_PORT"
free_port "$WEB_PORT"

if [[ "$IRIS_WEB_MODE" == "preview" ]]; then
  echo "Building the bundled Iris client for phone startup…"
  npm run build:web
fi

npm run dev:photon &
PIDS+=($!)

if [[ "$IRIS_WEB_MODE" == "preview" ]]; then
  PORT="$WEB_PORT" npm run preview --workspace @tempmhacks/web -- --port "$WEB_PORT" &
else
  PORT="$WEB_PORT" npm run dev:web &
fi
PIDS+=($!)

ngrok http --url="${NGROK_HOST}" "$WEB_PORT" &
PIDS+=($!)

echo "Waiting for health checks…"
wait_http "http://127.0.0.1:${PHOTON_PORT}/health" "Photon local"
wait_http "$HEALTH_URL" "Photon via ngrok"
wait_http "http://127.0.0.1:${WEB_PORT}" "Iris web"
wait_http "$NGROK_URL" "Iris via ngrok"

echo
echo "Stack is up. Keep this terminal open."
echo "  Iris web app:      http://127.0.0.1:${WEB_PORT}"
echo "  iPhone Iris URL:   ${NGROK_URL}"
echo "  Ngrok:             ${NGROK_URL}"
echo "  Ngrok inspector:   http://127.0.0.1:4040"
echo "  Health:            ${HEALTH_URL}"
echo
echo "Press Ctrl+C to stop Photon, ngrok, and web."

# Keep the script alive until a child exits or the user interrupts.
wait

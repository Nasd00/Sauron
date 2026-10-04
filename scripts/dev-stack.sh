#!/usr/bin/env bash
# Start Photon + ngrok + Iris web for local iOS / iMessage development.
# Ctrl+C / kill this script tears down every child process tree.
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PHOTON_PORT="${PHOTON_PORT:-3001}"
WEB_PORT="${WEB_PORT:-4173}"
NGROK_HOST="${NGROK_HOST:-starfish-revolving-footman.ngrok-free.dev}"
NGROK_URL="https://${NGROK_HOST}"
HEALTH_URL="${NGROK_URL}/health"

# Process-group leaders started by this script (PGID == PID with set -m).
PGS=()
CLEANING=0

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Freeing port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 0.4
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  fi
}

kill_group() {
  local pgid="$1"
  [[ -n "$pgid" ]] || return 0
  kill -TERM -"$pgid" 2>/dev/null || true
}

cleanup() {
  [[ "$CLEANING" -eq 1 ]] && return 0
  CLEANING=1
  trap - EXIT INT TERM HUP
  echo
  echo "Stopping stack (Photon, ngrok, web)…"

  local pgid
  for pgid in "${PGS[@]:-}"; do
    kill_group "$pgid"
  done

  # Give children a moment to exit cleanly, then force-kill leftovers.
  sleep 0.6
  for pgid in "${PGS[@]:-}"; do
    kill -KILL -"$pgid" 2>/dev/null || true
  done

  free_port "$PHOTON_PORT"
  free_port "$WEB_PORT"
  free_port 4040

  echo "Stack stopped."
}
trap cleanup EXIT INT TERM HUP

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

start_group() {
  # Runs "$@" in its own process group; stores the group leader PID in PGS.
  "$@" &
  local pid=$!
  PGS+=("$pid")
  echo "started pid=${pid}: $*"
}

echo "Starting Iris stack from ${ROOT}"
echo "  Photon  → :${PHOTON_PORT}"
echo "  ngrok   → ${NGROK_URL} → localhost:${PHOTON_PORT}"
echo "  Web     → http://127.0.0.1:${WEB_PORT}"
echo

command -v ngrok >/dev/null || { echo "ngrok is not on PATH. Install from https://ngrok.com/download" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is not on PATH" >&2; exit 1; }

free_port "$PHOTON_PORT"
free_port 4040

start_group npm run dev:photon
start_group ngrok http --url="${NGROK_HOST}" "$PHOTON_PORT"
start_group env PORT="$WEB_PORT" npm run dev:web

echo "Waiting for health checks…"
wait_http "http://127.0.0.1:${PHOTON_PORT}/health" "Photon local"
wait_http "$HEALTH_URL" "Photon via ngrok"
wait_http "http://127.0.0.1:${WEB_PORT}" "Iris web" || true

echo
echo "Stack is up. Keep this terminal open."
echo "  Iris web app:      http://127.0.0.1:${WEB_PORT}"
echo "  Ngrok:             ${NGROK_URL}"
echo "  Ngrok inspector:   http://127.0.0.1:4040"
echo "  Health:            ${HEALTH_URL}"
echo
echo "Press Ctrl+C to stop Photon, ngrok, and web."

# Stay alive until interrupted or a process-group leader exits.
wait

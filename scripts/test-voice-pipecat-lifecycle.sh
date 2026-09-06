#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT}/.voice-bot.pid"
ACTIVE_PID=""

port_is_free() {
    python3 - <<'PY'
import socket

try:
    connection = socket.create_connection(("127.0.0.1", 8765), timeout=0.5)
except OSError:
    raise SystemExit(0)
else:
    connection.close()
    raise SystemExit(1)
PY
}

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

cleanup() {
    cd "${ROOT}"
    make voice-pipecat-down >/dev/null 2>&1 || true

    if [[ "${ACTIVE_PID}" =~ ^[0-9]+$ ]] \
        && kill -0 "${ACTIVE_PID}" 2>/dev/null; then
        args="$(ps -p "${ACTIVE_PID}" -o args= 2>/dev/null || true)"
        if [[ "${args}" == *"${ROOT}/python/examples/voice/_bot/bot.py"* ]]; then
            kill -KILL "${ACTIVE_PID}" 2>/dev/null || true
        fi
    fi

    rm -f "${PID_FILE}"
}

trap cleanup EXIT
cd "${ROOT}"

port_is_free || fail "port 8765 is already in use before test"

for cycle in 1 2; do
    echo "=== lifecycle cycle ${cycle} ==="

    make voice-pipecat-up

    [[ -f "${PID_FILE}" ]] || fail "PID file was not created"
    ACTIVE_PID="$(cat "${PID_FILE}")"

    args="$(ps -p "${ACTIVE_PID}" -o args= 2>/dev/null || true)"
    [[ "${args}" == *"${ROOT}/python/examples/voice/_bot/bot.py"* ]] \
        || fail "PID does not point to the voice bot: ${args}"
    [[ "${args}" != *"uv run"* ]] \
        || fail "PID still points to the uv wrapper"

    output="$(make voice-pipecat-down)"
    printf '%s\n' "${output}"

    [[ "${output}" != *"SIGKILL"* ]] \
        || fail "voice bot did not shut down gracefully"
    [[ ! -f "${PID_FILE}" ]] \
        || fail "PID file remains after shutdown"
    ! kill -0 "${ACTIVE_PID}" 2>/dev/null \
        || fail "voice bot process remains after shutdown"
    port_is_free || fail "port 8765 remains bound after shutdown"

    ACTIVE_PID=""
done

make voice-pipecat-down
trap - EXIT

echo "VOICE_PIPECAT_LIFECYCLE_TEST_OK"

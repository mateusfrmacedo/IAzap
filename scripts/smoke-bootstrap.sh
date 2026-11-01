#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$(mktemp -d /tmp/zapia-bootstrap.XXXXXX)"
trap 'rm -rf "$RUNTIME"' EXIT
cd "$ROOT"
swiftc -parse-as-library -o "$RUNTIME/smoke" scripts/tests/BootstrapSmoke.swift \
  ZapIA/ZapIA/Bridge/*.swift ZapIA/ZapIA/Models/*.swift ZapIA/ZapIA/Store/AppStore.swift
ZAPIA_BRIDGE_DIR="$ROOT/bridge" ZAPIA_SOCKET="$RUNTIME/bridge.sock" \
  ZAPIA_AUTH="$RUNTIME/auth" ZAPIA_DATA="$RUNTIME/data" ZAPIA_ENGINE=stub "$RUNTIME/smoke"

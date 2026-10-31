#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$(mktemp -d /tmp/iazap-bootstrap.XXXXXX)"
trap 'rm -rf "$RUNTIME"' EXIT
cd "$ROOT"
swiftc -parse-as-library -o "$RUNTIME/smoke" scripts/tests/BootstrapSmoke.swift \
  IAZAP/IAZAP/Bridge/*.swift IAZAP/IAZAP/Models/Models.swift IAZAP/IAZAP/Store/AppStore.swift
IAZAP_BRIDGE_DIR="$ROOT/bridge" IAZAP_SOCKET="$RUNTIME/bridge.sock" \
  IAZAP_AUTH="$RUNTIME/auth" IAZAP_DATA="$RUNTIME/data" IAZAP_ENGINE=stub "$RUNTIME/smoke"

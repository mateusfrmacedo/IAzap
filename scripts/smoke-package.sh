#!/usr/bin/env bash
# Exercise bundled Node + production bridge with no Node/npm on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP="${1:-$ROOT/dist-mac/IAZAP-apple-silicon.zip}"
RUNTIME="$(mktemp -d /tmp/iazap-packaged.XXXXXX)"
trap 'rm -rf "$RUNTIME"' EXIT
ditto -x -k "$ZIP" "$RUNTIME"
APP="$RUNTIME/IAZAP.app"
codesign --verify --deep --strict "$APP"
# A test binary inside the bundle must not write the real app's UserDefaults.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.iazap.smoke-test.$(uuidgen)" "$APP/Contents/Info.plist"
# Compile the same bootstrap harness inside a disposable copy so Bundle.main resolves resources.
swiftc -parse-as-library -o "$APP/Contents/MacOS/BootstrapSmoke" \
  "$ROOT/scripts/tests/BootstrapSmoke.swift" "$ROOT"/IAZAP/IAZAP/Bridge/*.swift \
  "$ROOT/IAZAP/IAZAP/Models/Models.swift" "$ROOT/IAZAP/IAZAP/Store/AppStore.swift"
env -u IAZAP_BRIDGE_DIR PATH=/usr/bin:/bin IAZAP_PACKAGED_TEST=1 \
  IAZAP_SOCKET="$RUNTIME/bridge.sock" IAZAP_AUTH="$RUNTIME/auth" \
  IAZAP_DATA="$RUNTIME/data" IAZAP_ENGINE=stub "$APP/Contents/MacOS/BootstrapSmoke"

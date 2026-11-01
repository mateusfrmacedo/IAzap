#!/usr/bin/env bash
# Exercise bundled Node + production bridge with no Node/npm on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP="${1:-$ROOT/dist-mac/ZapIA-apple-silicon.zip}"
RUNTIME="$(mktemp -d /tmp/zapia-packaged.XXXXXX)"
trap 'rm -rf "$RUNTIME"' EXIT
ditto -x -k "$ZIP" "$RUNTIME"
APP="$RUNTIME/ZapIA.app"
codesign --verify --deep --strict "$APP"
# A test binary inside the bundle must not write the real app's UserDefaults.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.zapia.smoke-test.$(uuidgen)" "$APP/Contents/Info.plist"
# Compile the same bootstrap harness inside a disposable copy so Bundle.main resolves resources.
swiftc -parse-as-library -o "$APP/Contents/MacOS/BootstrapSmoke" \
  "$ROOT/scripts/tests/BootstrapSmoke.swift" "$ROOT"/ZapIA/ZapIA/Bridge/*.swift \
  "$ROOT"/ZapIA/ZapIA/Models/*.swift "$ROOT/ZapIA/ZapIA/Store/AppStore.swift"
env -u ZAPIA_BRIDGE_DIR PATH=/usr/bin:/bin ZAPIA_PACKAGED_TEST=1 \
  ZAPIA_SOCKET="$RUNTIME/bridge.sock" ZAPIA_AUTH="$RUNTIME/auth" \
  ZAPIA_DATA="$RUNTIME/data" ZAPIA_ENGINE=stub "$APP/Contents/MacOS/BootstrapSmoke"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/bridge/bin/zapia-apple-engine}"
mkdir -p "$(dirname "$OUTPUT")"
xcrun --sdk macosx swiftc -O -parse-as-library -target "$(uname -m)-apple-macos14.0" \
  "$ROOT/native/AppleReplyHelper.swift" -o "$OUTPUT"

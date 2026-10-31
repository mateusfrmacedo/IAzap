#!/usr/bin/env bash
# IAZAP — one-command Mac run (install bridge deps, open Xcode / build+launch).
# Usage: ./scripts/run-mac.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/bridge"
XCODEPROJ="$ROOT/IAZAP/IAZAP.xcodeproj"
export IAZAP_BRIDGE_DIR="$BRIDGE"
export IAZAP_TOKEN="${IAZAP_TOKEN:-dev-token-change-me}"

echo "==> IAZAP repo: $ROOT"
echo "==> Bridge:    $IAZAP_BRIDGE_DIR"
echo "==> Token:     $IAZAP_TOKEN"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Erro: Node.js/npm não encontrado. Instale Node 22+ (https://nodejs.org)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Erro: Node >= 20 necessário (encontrado $(node -v))." >&2
  exit 1
fi

echo "==> npm install (bridge)"
(
  cd "$BRIDGE"
  npm install
)

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Este script prepara o bridge; o app SwiftUI só roda no macOS."
  echo "No Mac: git pull, ./scripts/run-mac.sh"
  exit 0
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "==> xcodebuild não encontrado — abrindo Xcode."
  open "$XCODEPROJ"
  echo "No Xcode: scheme IAZAP → My Mac → Run."
  echo "O app inicia o bridge sozinho; escaneie o QR em Parear."
  exit 0
fi

DERIVED="$ROOT/.derivedData"
echo "==> xcodebuild (Debug, My Mac)"
xcodebuild \
  -project "$XCODEPROJ" \
  -scheme IAZAP \
  -configuration Debug \
  -derivedDataPath "$DERIVED" \
  -destination 'platform=macOS' \
  build

APP="$(find "$DERIVED/Build/Products/Debug" -maxdepth 1 -name 'IAZAP.app' -print -quit)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "Build ok, mas IAZAP.app não encontrado — abrindo Xcode." >&2
  open "$XCODEPROJ"
  exit 1
fi

# Ensure tip file exists even if build phase missed it
RESOURCES="$APP/Contents/Resources"
mkdir -p "$RESOURCES"
printf '%s' "$BRIDGE" > "$RESOURCES/bridge-root.txt"

echo "==> Launch $APP"
# Launch binary directly so IAZAP_* env vars are inherited (open(1) does not forward them).
"$APP/Contents/MacOS/IAZAP" &
echo "IAZAP iniciado (pid $!)."
echo "Fluxo: aceite o aviso ToS em Parear → QR grande aparece → escaneie no WhatsApp."

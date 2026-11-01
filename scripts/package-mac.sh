#!/usr/bin/env bash
# Build a self-contained Apple Silicon app and a drag-to-Applications disk image.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist-mac}"
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/zapia-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
NODE="$(command -v node)"
node -e 'require("node:sqlite")'
(cd "$ROOT/bridge" && npm ci && npm run build && npm test)
xcodebuild -project "$ROOT/ZapIA/ZapIA.xcodeproj" -scheme ZapIA \
  -configuration Release -derivedDataPath "$ROOT/.derivedData" \
  -destination 'generic/platform=macOS' ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
APP="$STAGE/ZapIA.app"
ditto "$ROOT/.derivedData/Build/Products/Release/ZapIA.app" "$APP"
RESOURCES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/Helpers" "$RESOURCES/bridge"
if lipo -info "$NODE" | grep -q 'Architectures in the fat file'; then
  lipo "$NODE" -thin arm64 -output "$APP/Contents/Helpers/node"
else
  lipo -verify_arch arm64 "$NODE"
  cp "$NODE" "$APP/Contents/Helpers/node"
fi
chmod +x "$APP/Contents/Helpers/node"
# The packaged app must resolve its own resources, never a developer's checkout.
rm -f "$RESOURCES/bridge-root.txt"
cp "$ROOT/bridge/package.json" "$ROOT/bridge/package-lock.json" "$RESOURCES/bridge/"
ditto "$ROOT/bridge/dist" "$RESOURCES/bridge/dist"
(cd "$RESOURCES/bridge" && npm ci --omit=dev)
# Include the inference service sources for optional MLX setup; weights are downloaded separately.
ditto --norsrc "$ROOT/mlx-service" "$RESOURCES/mlx-service"
rm -rf "$RESOURCES/mlx-service/.venv" "$RESOURCES/mlx-service/__pycache__"
# Ad-hoc signature supports local testing. Public distribution requires Developer ID + notarization.
xattr -cr "$APP"
codesign --force --sign - "$APP/Contents/Helpers/node"
codesign --force --sign - "$APP/Contents/Helpers/zapia-apple-engine"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/LEIA-ME.txt" <<'TEXT'
ZapIA — macOS 14+ / Apple Silicon

Arraste ZapIA para Aplicativos e abra o app. Node e bridge já estão incluídos.
Em Parear, leia o aviso e escaneie o QR pelo WhatsApp > Aparelhos conectados.
O auto-reply inicia desligado; selecione as conversas e configure o modelo antes de ativar.

Esta versão de teste tem assinatura ad-hoc e não é notarizada pela Apple.
Em outro Mac, o sistema pode exigir aprovação em Ajustes do Sistema > Privacidade e Segurança.

Apple Intelligence está disponível em Ajustes > Inteligência artificial (macOS 26+).
O serviço MLX e os pesos Qwen exigem configuração separada, conforme o README do projeto.
Sem o serviço MLX, o motor utiliza respostas de demonstração identificadas como stub.
https://github.com/mateusfrmacedo/ZapIA
TEXT
hdiutil create -volname ZapIA -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT/ZapIA-apple-silicon.dmg"
ditto -c -k --keepParent "$APP" "$OUTPUT/ZapIA-apple-silicon.zip"
echo "App empacotado em $OUTPUT"

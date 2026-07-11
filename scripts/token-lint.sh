#!/usr/bin/env bash
# Belt-and-braces token guard: fails the build if any hex/rgb color literal
# appears in tool or app source outside the allowed token/theme locations.
set -euo pipefail
cd "$(dirname "$0")/.."

violations=$(grep -rnE '#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(' \
  --include='*.ts' --include='*.tsx' --include='*.css' \
  apps/desktop/src packages/tools packages/core packages/plugin-api packages/ui 2>/dev/null \
  | grep -v 'packages/ui/src/tokens.css' \
  | grep -v 'token-lint-allow' || true)

if [ -n "$violations" ]; then
  echo "❌ Hardcoded colors found (design tokens only!):"
  echo "$violations"
  exit 1
fi
echo "✅ token-lint: no hardcoded colors."

#!/bin/sh
# Cardo installer for macOS and Linux.
# Fetches the latest release from GitHub and installs it:
#   macOS → /Applications/Cardo.app   Linux → ~/.local/bin/cardo (AppImage)
# Downloading via curl sets no macOS quarantine attribute, so Gatekeeper
# does not block the unsigned build.
set -eu

REPO="GITHUB_USER/cardo-app"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '%s\n' "$*"; }
fail() { say "✗ $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required."

say "→ Looking up the latest Cardo release…"
ASSETS=$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4) \
  || fail "Could not reach GitHub. Are you online?"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    URL=$(printf '%s\n' "$ASSETS" | grep -i '\.dmg$' | grep -i 'universal' | head -n1)
    [ -n "${URL:-}" ] || URL=$(printf '%s\n' "$ASSETS" | grep -i '\.dmg$' | head -n1)
    [ -n "${URL:-}" ] || fail "No macOS build found in the latest release."

    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    say "→ Downloading $(basename "$URL")…"
    curl -fL --progress-bar "$URL" -o "$TMP/cardo.dmg"

    say "→ Installing to /Applications…"
    MOUNT=$(hdiutil attach -nobrowse -readonly "$TMP/cardo.dmg" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
    [ -n "$MOUNT" ] || fail "Could not mount the disk image."
    rm -rf /Applications/Cardo.app
    cp -R "$MOUNT/Cardo.app" /Applications/
    hdiutil detach "$MOUNT" -quiet || true
    say "✓ Done! Cardo is in /Applications – open it from Launchpad or Spotlight."
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) PAT='amd64\.AppImage$' ;;
      aarch64|arm64) PAT='aarch64\.AppImage$' ;;
      *) fail "Unsupported architecture: $ARCH" ;;
    esac
    URL=$(printf '%s\n' "$ASSETS" | grep -iE "$PAT" | head -n1)
    [ -n "${URL:-}" ] || fail "No Linux build for $ARCH found in the latest release."

    BIN_DIR="${XDG_DATA_HOME:-$HOME/.local}/bin"
    [ -d "$HOME/.local/bin" ] && BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    say "→ Downloading $(basename "$URL")…"
    curl -fL --progress-bar "$URL" -o "$BIN_DIR/cardo"
    chmod +x "$BIN_DIR/cardo"
    say "✓ Done! Start Cardo with: $BIN_DIR/cardo"
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *) say "  (Add $BIN_DIR to your PATH to start it with just 'cardo'.)" ;;
    esac
    ;;
  *)
    fail "Unsupported OS: $OS (on Windows, use install.ps1)"
    ;;
esac

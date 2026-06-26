#!/usr/bin/env bash
# Publish the Tatoeba flashcards userscript so Tampermonkey auto-updates every device.
# Single source of truth: this repo. Edit the .user.js here, bump @version, then run ./publish.sh
set -euo pipefail

# Resolve the repo dir from this script's location (works wherever the repo lives).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="$DIR/tatoeba-flashcards.user.js"

[ -f "$FILE" ] || { echo "Script not found: $FILE"; exit 1; }

# Push as the personal account (two gh accounts live on this machine).
if command -v gh >/dev/null 2>&1; then
  gh auth switch -u willcas36 -h github.com >/dev/null 2>&1 || true
fi

# Syntax gate before publishing anything broken.
node --check "$FILE"

# Read the version from the header for the commit message.
VER=$(grep -m1 -E '^// @version' "$FILE" | awk '{print $3}')

cd "$DIR"

if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to publish (working tree is clean)."
  exit 0
fi

git add -A
git commit -q -m "release: v${VER}"
git push -q origin main
echo "Published v${VER} -> https://github.com/willcas36/tatoeba-flashcards"
echo "Tampermonkey picks it up on its next update check (devices already installed from the raw URL)."

#!/usr/bin/env bash
# Publish one userscript from the monorepo so Tampermonkey auto-updates every device.
# Usage: ./publish.sh <script-folder>     e.g. ./publish.sh tatoeba-flashcards
# Single source of truth: this repo. Edit the .user.js, bump its @version, then publish.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Collect available script folders (each holds <folder>/<folder>.user.js).
scripts=()
for d in "$DIR"/*/; do
  name="$(basename "$d")"
  [ -f "$d/$name.user.js" ] && scripts+=("$name")
done

if [ ${#scripts[@]} -eq 0 ]; then
  echo "No scripts found in $DIR"
  exit 1
fi

NAME="${1:-}"

# No argument -> interactive picker.
if [ -z "$NAME" ]; then
  echo "Which script do you want to publish?"
  PS3="#? "
  select choice in "${scripts[@]}"; do
    if [ -n "$choice" ]; then
      NAME="$choice"
      break
    fi
    echo "Invalid choice — pick a number from the list."
  done
fi

FILE="$DIR/$NAME/$NAME.user.js"
if [ ! -f "$FILE" ]; then
  echo "Not found: $FILE"
  printf '  - %s\n' "${scripts[@]}"
  exit 1
fi

# Push as the personal account (two gh accounts live on this machine).
if command -v gh >/dev/null 2>&1; then
  gh auth switch -u willcas36 -h github.com >/dev/null 2>&1 || true
fi

# Syntax gate.
node --check "$FILE"

# Version from the header for the commit message.
VER=$(grep -m1 -E '^// @version' "$FILE" | awk '{print $NF}')

cd "$DIR"
git add "$NAME"

if git diff --cached --quiet; then
  echo "No changes to publish in '$NAME' (already up to date)."
  exit 0
fi

git commit -q -m "release($NAME): v${VER}"
git push -q origin main
echo "Published $NAME v${VER}"
echo "  -> https://raw.githubusercontent.com/willcas36/userscripts/main/$NAME/$NAME.user.js"
echo "Tampermonkey picks it up on its next update check (devices installed from the raw URL)."

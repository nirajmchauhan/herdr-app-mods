#!/bin/sh
# Installs these mods, the herdr-plus layout, the Claude Code skills and the hc
# worker templates, then switches Herdr to herdr-plus.
# Never overwrites an existing file unless run with --force.
#   ./install.sh           install what's missing
#   ./install.sh --force   replace installed copies with this repo's
set -eu

HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")" && pwd)"
LAYOUT=herdr-plus
FORCE=0
[ $# -le 1 ] || { echo "usage: $0 [--force]" >&2; exit 2; }
case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac

[ -d "$HOME_DIR/layouts" ] || { echo "Herdr app home not found at $HOME_DIR: open Herdr once first." >&2; exit 1; }

put() { # put <src> <dst>
  if [ -e "$2" ] && [ "$FORCE" -eq 0 ]; then
    cmp -s "$1" "$2" || echo "kept (differs, use --force): $2"
  else
    cp "$1" "$2" && echo "installed: $2"
  fi
}

for dir in "$REPO"/mods/*/; do
  name=$(basename "$dir")
  mkdir -p "$HOME_DIR/mods/$name"
  # mod.json first: a folder Herdr sees without one gets docked into the layout.
  put "$dir/mod.json" "$HOME_DIR/mods/$name/mod.json"
  for f in "$dir"*; do
    case "$(basename "$f")" in mod.json | jsconfig.json | *.d.ts) continue ;; esac  # the app writes the last two
    put "$f" "$HOME_DIR/mods/$name/$(basename "$f")"
  done
done
for f in "$REPO"/layouts/*; do
  put "$f" "$HOME_DIR/layouts/$(basename "$f")"
done

# Our layouts point at the *-synced mods, which mod-patches writes once one of them
# is showing. Seed missing ones with Herdr's unpatched mods so nothing is blank.
for m in workspace-status workspace-chrome tabs; do
  if [ ! -e "$HOME_DIR/mods/$m-synced/main.js" ]; then
    mkdir -p "$HOME_DIR/mods/$m-synced"
    cp "$HOME_DIR/mods/$m/mod.json" "$HOME_DIR/mods/$m-synced/mod.json"
    cp "$HOME_DIR/mods/$m/main.js" "$HOME_DIR/mods/$m-synced/main.js"
    echo "seeded: $HOME_DIR/mods/$m-synced"
  fi
done

for dir in "$REPO"/skills/*/; do
  name=$(basename "$dir")
  mkdir -p "$HOME/.claude/skills/$name"
  put "$dir/SKILL.md" "$HOME/.claude/skills/$name/SKILL.md"
done

TPL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/templates"
mkdir -p "$TPL_DIR"
for f in "$REPO"/hc-templates/*.md; do
  put "$f" "$TPL_DIR/$(basename "$f")"
done

for dir in "$REPO"/mods/*/; do
  herdr-app check "$HOME_DIR/mods/$(basename "$dir")"
done
herdr-app do layout.switch "{\"name\":\"$LAYOUT\"}" >/dev/null 2>&1 \
  && echo "switched to $LAYOUT (mod-patches writes the *-synced mods in a few seconds)" \
  || echo "open Herdr, then: herdr-app do layout.switch '{\"name\":\"$LAYOUT\"}'"

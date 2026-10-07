#!/bin/sh
# Installs the Runway mods for Claude Code by linking each mod's folder into
# ~/.claude/skills, where Claude Code loads a mod in every new chat.
#
#   ./install.sh                     all four mods
#   ./install.sh runway mac-load     just those
#   ./install.sh --remove [mod ...]  takes the links away again
set -eu

here=$(cd "$(dirname "$0")" && pwd)
skills="$HOME/.claude/skills"
all="runway mac-load commit-nudge usage-breakdown"

remove=false
if [ "${1:-}" = "--remove" ]; then
  remove=true
  shift
fi

mods=${*:-$all}
mkdir -p "$skills"

for mod in $mods; do
  if [ ! -f "$here/$mod/.claude-plugin/plugin.json" ]; then
    echo "No mod named $mod. The mods are: $all" >&2
    exit 1
  fi

  link="$skills/$mod"
  ours=false
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$here/$mod" ]; then
    ours=true
  fi

  if $remove; then
    if $ours; then
      rm "$link"
      echo "Removed $mod"
    fi
    continue
  fi

  if $ours; then
    echo "Already linked: $mod"
    continue
  fi

  # Anything else by that name is the person's own: leave it be.
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "Skipped $mod: $link already exists" >&2
    continue
  fi

  ln -s "$here/$mod" "$link"
  echo "Linked $mod"
done

if ! $remove; then
  echo "New chats load them. To have them reach chats that are already open, see the README."
fi

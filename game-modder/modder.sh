#!/usr/bin/env sh
# Linux/macOS launcher, e.g.:  ./modder.sh chat ~/.steam/steam/steamapps/common/MyGame
DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHONPATH="$DIR${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m modder "$@"

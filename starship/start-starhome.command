#!/bin/sh
# Starhome launcher for macOS / Linux: double-click (macOS) or run ./start-starhome.command
cd "$(dirname "$0")"
URL=http://localhost:8080/
( sleep 1; (command -v open >/dev/null && open "$URL") || xdg-open "$URL" ) >/dev/null 2>&1 &
echo "Starhome is running at $URL  (close this window to stop)"
if command -v node >/dev/null; then exec node serve.mjs; else exec python3 -m http.server 8080; fi

#!/bin/zsh -l
# Double-click (macOS): starts the FDM price calculator and opens it in the browser.
# Doppelklick (macOS): startet den FDM-Preisrechner und öffnet ihn im Browser.
# Stop / Beenden: close this Terminal window or press Ctrl+C.

cd "${0:A:h}" || exit 1

if ! command -v node >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
  for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.volta/bin"; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found – please install it from https://nodejs.org"
  echo "Node.js wurde nicht gefunden – bitte von https://nodejs.org installieren."
  read -k 1 "?Press any key to close / Taste drücken zum Schließen … "
  exit 1
fi

node server.js --open

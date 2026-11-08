#!/bin/zsh -l
# Doppelklick (macOS): startet den FDM-Preisrechner und öffnet ihn im Browser.
# Beenden: dieses Terminalfenster schließen oder Ctrl+C drücken.

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
  echo "Node.js wurde nicht gefunden. Bitte installieren: https://nodejs.org"
  read -k 1 "?Taste drücken zum Schließen … "
  exit 1
fi

node server.js --open

#!/bin/sh
# Reinicia ChatGPT 2 (cierra solo su instancia y la vuelve a abrir). Lo usa el botón "Reiniciar" de Ajustes.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sleep 1
pkill -f "[u]ser-data-dir=$HOME/.config/Codex-2"
sleep 3
exec setsid "$ROOT/bin/chatgpt2" >/dev/null 2>&1 < /dev/null

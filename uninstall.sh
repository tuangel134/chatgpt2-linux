#!/usr/bin/env bash
# ChatGPT 2 para Linux · desinstalador
# Quita la app, el comando y el acceso del menú. Por defecto CONSERVA tus datos (cuentas, chats, configuración).
#   --purge   borra también los datos: ~/.codex-2, ~/.config/Codex-2, ~/.cli-proxy-api (¡cuentas conectadas!) y la caché de descargas
#   --prefix  carpeta de instalación (por defecto ~/.local/opt/chatgpt2)
set -euo pipefail
PREFIX="${CHATGPT2_HOME:-$HOME/.local/opt/chatgpt2}"
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --prefix) PREFIX="${2:?falta la carpeta}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opción desconocida: $1" >&2; exit 1 ;;
  esac
done
DATA="${CODEX_HOME:-$HOME/.codex-2}"

echo "Cerrando procesos de ChatGPT 2..."
pkill -f "[u]ser-data-dir=$HOME/.config/Codex-2" 2>/dev/null || true
pkill -f "$PREFIX/modelhub/modelhub.py" 2>/dev/null || true
pkill -f "$PREFIX/mastermcp/host.cjs" 2>/dev/null || true
pkill -f "$PREFIX/remote/agent.cjs" 2>/dev/null || true
pkill -f "$PREFIX/cliproxyapi/cli-proxy-api" 2>/dev/null || true
sleep 1

# Seguridad: solo borrar si parece una instalación nuestra
if [ -d "$PREFIX" ]; then
  if [ -f "$PREFIX/modelhub/patch_ui.py" ] || [ -f "$PREFIX/bin/chatgpt2" ]; then
    rm -rf "$PREFIX"; echo "borrado: $PREFIX"
  else
    echo "No parece una instalación de ChatGPT 2: $PREFIX (no se borra)." >&2
  fi
fi
[ "$(readlink -f "$HOME/.local/bin/chatgpt2" 2>/dev/null || true)" = "$PREFIX/bin/chatgpt2" ] && rm -f "$HOME/.local/bin/chatgpt2" && echo "borrado: ~/.local/bin/chatgpt2"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/chatgpt2.desktop"
if [ "$PURGE" -eq 1 ]; then
  rm -rf "$DATA" "$HOME/.config/Codex-2" "$HOME/.cli-proxy-api" "${XDG_CACHE_HOME:-$HOME/.cache}/chatgpt2"
  echo "datos borrados (cuentas, chats y caché)."
else
  echo "Tus datos se conservan en $DATA y ~/.config/Codex-2 (usa --purge para borrarlos)."
fi
echo "Listo."

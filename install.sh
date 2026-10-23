#!/usr/bin/env bash
# ChatGPT 2 para Linux · instalador
#
# Qué hace (todo en tu carpeta de usuario, sin tocar tu ChatGPT/Codex normal):
#   1. Detecta tu distro e instala lo que falte (curl, python3, node, librerías de Electron...).
#   2. Descarga la app oficial de OpenAI (.deb, versión fijada y verificada con SHA-256) y la extrae SIN instalarla.
#   3. Descarga CLIProxyAPI (el proxy de modelos, código abierto) y verifica su SHA-256.
#   4. Copia el hub de modelos, el Master MCP y el lanzador, y aplica los parches a la interfaz.
#   5. Crea el comando `chatgpt2` y el acceso en el menú de aplicaciones.
#
# Uso:  ./install.sh [opciones]       (o:  curl -fsSL <url>/install.sh | bash)
#   --prefix DIR        dónde instalar (por defecto ~/.local/opt/chatgpt2)
#   --deb ARCHIVO       usar un .deb ya descargado en vez de bajarlo
#   --version X.Y.Z     versión de la app de OpenAI (por defecto la probada; otras pueden romper los parches)
#   --skip-deps         no instalar dependencias del sistema (solo comprobar)
#   --no-menu           no crear el acceso en el menú de aplicaciones
#   --yes               no preguntar nada (sudo sí puede pedir tu contraseña)
#   -h, --help          esta ayuda
set -euo pipefail

REPO="tuangel134/chatgpt2-linux"
APP_VERSION_TESTED="26.930.31730"
APP_SHA256_TESTED_AMD64="e0174d8d0a5f4141145458c814f3c2d863dd67e942b868785a1f5dac9cba3e16"
CPA_VERSION="8.0.33"
APP_POOL="https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt"

PREFIX="${CHATGPT2_HOME:-$HOME/.local/opt/chatgpt2}"
APP_VERSION="$APP_VERSION_TESTED"
DEB_FILE=""
SKIP_DEPS=0
NO_MENU=0
ASSUME_YES=0
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/chatgpt2"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s[aviso]%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)    PREFIX="${2:?falta la carpeta}"; shift 2 ;;
    --deb)       DEB_FILE="${2:?falta el archivo}"; shift 2 ;;
    --version)   APP_VERSION="${2:?falta la versión}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --no-menu)   NO_MENU=1; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    -h|--help)   usage ;;
    *) die "opción desconocida: $1 (usa --help)" ;;
  esac
done

# --- «curl | bash»: el script llega por la entrada estándar y no hay carpetas hermanas. En ese caso solo se baja el
# repositorio y se ejecuta el instalador real desde un archivo (así ningún comando puede tragarse el script).
_self="${BASH_SOURCE[0]:-}"
if [ -z "$_self" ] || [ ! -f "$_self" ] || [ ! -f "$(dirname "$_self")/modelhub/patch_ui.py" ]; then
  command -v curl >/dev/null 2>&1 || { echo "[error] Hace falta curl para el instalador de una línea (o usa: git clone https://github.com/$REPO.git)." >&2; exit 1; }
  _boot="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2-boot.XXXXXX")"
  echo "Descargando el instalador de https://github.com/$REPO ..."
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$_boot" || { echo "[error] No se pudo bajar el repositorio." >&2; exit 1; }
  CHATGPT2_BOOT_DIR="$_boot" exec bash "$_boot/$(basename "$REPO")-main/install.sh" "$@" </dev/null
fi

# Todo el cuerpo va dentro de main(): así, con «curl | bash», bash lee el script completo antes de ejecutarlo
# y ningún comando (apt, sudo...) puede tragarse el resto del script desde la entrada estándar.
main() {
# ---------------------------------------------------------------- 0. comprobaciones previas
step "Comprobando el sistema"
[ "$(uname -s)" = "Linux" ] || die "Solo Linux (la app de OpenAI para escritorio en Linux es la que se parchea)."
[ "$(id -u)" -ne 0 ] || die "No lo ejecutes como root: se instala en tu carpeta de usuario (te pedirá sudo solo si falta algún paquete)."
case "$(uname -m)" in
  x86_64|amd64)  ARCH_DEB="amd64";  ARCH_CPA="amd64" ;;
  aarch64|arm64) ARCH_DEB="arm64";  ARCH_CPA="aarch64"; warn "arm64 es experimental: no está probado ni fijado con SHA-256." ;;
  *) die "Arquitectura no soportada: $(uname -m)" ;;
esac
info "arquitectura: $(uname -m) · destino: $PREFIX"

PM=""
for c in apt-get dnf pacman zypper; do have "$c" && { PM="$c"; break; }; done
info "gestor de paquetes: ${PM:-ninguno detectado}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then have sudo && SUDO="sudo"; fi

# ---------------------------------------------------------------- 1. dependencias
pm_install() {  # instala paquetes con el gestor detectado
  [ "$#" -gt 0 ] || return 0
  [ -n "$PM" ] || die "No encuentro apt/dnf/pacman/zypper. Instala a mano: $*"
  [ -n "$SUDO" ] || die "Faltan paquetes ($*) y no hay sudo. Instálalos como administrador y vuelve a ejecutar."
  case "$PM" in
    apt-get) $SUDO apt-get update -qq </dev/null || true; $SUDO apt-get install -y "$@" </dev/null ;;
    dnf)     $SUDO dnf install -y "$@" </dev/null ;;
    pacman)  $SUDO pacman -S --needed --noconfirm "$@" </dev/null ;;
    zypper)  $SUDO zypper --non-interactive install "$@" </dev/null ;;
  esac
}

# Paquetes por distro para las herramientas del propio instalador
tools_pkgs() {
  case "$PM" in
    apt-get) echo "curl ca-certificates xz-utils binutils tar python3 nodejs" ;;
    dnf)     echo "curl ca-certificates xz binutils tar python3 nodejs" ;;
    pacman)  echo "curl ca-certificates xz binutils tar python nodejs" ;;
    zypper)  echo "curl ca-certificates xz binutils tar python3 nodejs" ;;
  esac
}
# Librerías que necesita Electron (en apt se leen del propio .deb; aquí las equivalentes de las demás distros)
runtime_pkgs() {
  case "$PM" in
    dnf)    echo "gtk3 nss alsa-lib at-spi2-core at-spi2-atk cups-libs libdrm mesa-libgbm libxkbcommon libXcomposite libXdamage libXrandr libXfixes libXext libxcb libnotify libusb1 xdg-utils pango cairo dbus-libs expat nspr" ;;
    pacman) echo "gtk3 nss alsa-lib at-spi2-core cups libdrm mesa libxkbcommon libxcomposite libxdamage libxrandr libxfixes libxext libxcb libnotify libusb xdg-utils pango cairo dbus expat nspr" ;;
    zypper) echo "gtk3 mozilla-nss alsa libatk-bridge-2_0-0 cups-libs libdrm2 libgbm1 libxkbcommon0 libXcomposite1 libXdamage1 libXrandr2 libXfixes3 libXext6 libxcb1 libnotify4 libusb-1_0-0 xdg-utils libpango-1_0-0 libcairo2 libdbus-1-3 libexpat1 mozilla-nspr" ;;
  esac
}

install_tools() {
  local missing=() t
  for t in curl tar xz ar python3; do have "$t" || missing+=("$t"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    info "faltan herramientas: ${missing[*]}"
    [ "$SKIP_DEPS" -eq 0 ] || die "Faltan: ${missing[*]} (usaste --skip-deps)."
    # shellcheck disable=SC2046
    pm_install $(tools_pkgs)
  fi
  have curl && have tar && have xz && have ar && have python3 || die "Siguen faltando herramientas básicas (curl, tar, xz, ar, python3)."
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "Hace falta Python 3.8 o superior."
  info "python3 $(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') · curl · tar · xz · ar  ✓"
}

NODE_OK=0
install_node() {
  local major=0
  if have node; then major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
  if [ "$major" -lt 18 ] && [ "$SKIP_DEPS" -eq 0 ] && [ -n "$PM" ]; then
    info "node 18+ no encontrado: intentando instalar nodejs (solo hace falta para Master MCP)"
    pm_install nodejs || warn "No se pudo instalar nodejs."
    have node && major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ "$major" -ge 18 ]; then NODE_OK=1; info "node $(node -v) ✓";
  else warn "Sin node 18+: la app funciona, pero Master MCP quedará desactivado. Instala nodejs 18+ y vuelve a ejecutar."; fi
}

step "Herramientas básicas"
install_tools
install_node

# ---------------------------------------------------------------- 2. obtener la app de OpenAI
step "App oficial de OpenAI ($APP_VERSION)"
mkdir -p "$CACHE"
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
if [ -z "$DEB_FILE" ]; then
  DEB_FILE="$CACHE/chatgpt_${APP_VERSION}_${ARCH_DEB}.deb"
  WANT=""
  if [ "$APP_VERSION" = "$APP_VERSION_TESTED" ] && [ "$ARCH_DEB" = "amd64" ]; then WANT="$APP_SHA256_TESTED_AMD64"; fi
  if [ -f "$DEB_FILE" ] && [ -n "$WANT" ] && [ "$(sha_of "$DEB_FILE")" != "$WANT" ]; then rm -f "$DEB_FILE"; fi
  if [ ! -f "$DEB_FILE" ]; then
    info "descargando ~450 MB desde persistent.oaistatic.com (servidor oficial de OpenAI)..."
    curl -fL --retry 3 --progress-bar -o "$DEB_FILE.part" "$APP_POOL/chatgpt_${APP_VERSION}_${ARCH_DEB}.deb" \
      || { rm -f "$DEB_FILE.part"; die "No se pudo descargar la app (¿versión $APP_VERSION inexistente o sin internet?)."; }
    mv "$DEB_FILE.part" "$DEB_FILE"
  else
    info "ya descargada: $DEB_FILE"
  fi
  if [ -n "$WANT" ]; then
    [ "$(sha_of "$DEB_FILE")" = "$WANT" ] || { rm -f "$DEB_FILE"; die "El SHA-256 del .deb no coincide con el esperado; descarga borrada. Reintenta."; }
    info "SHA-256 verificado ✓"
  else
    warn "Versión/arquitectura sin SHA-256 fijado: no se pudo verificar la descarga."
  fi
else
  [ -f "$DEB_FILE" ] || die "No existe $DEB_FILE"
  info "usando $DEB_FILE (no verificado)"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2-install.XXXXXX")"
trap 'rm -rf "$WORK" ${CHATGPT2_BOOT_DIR:+"$CHATGPT2_BOOT_DIR"}' EXIT
step "Extrayendo (sin instalar nada en el sistema)"
( cd "$WORK" && ar x "$DEB_FILE" ) || die "El .deb no se pudo abrir."
DATA_TAR="$(ls "$WORK"/data.tar.* 2>/dev/null | head -1)"; CTRL_TAR="$(ls "$WORK"/control.tar.* 2>/dev/null | head -1)"
[ -n "$DATA_TAR" ] || die "El .deb no contiene data.tar.*"
mkdir -p "$WORK/root" "$WORK/ctl"
tar -xf "$DATA_TAR" -C "$WORK/root" || die "No se pudo extraer los archivos del .deb (¿falta xz o zstd?)."
[ -n "$CTRL_TAR" ] && tar -xf "$CTRL_TAR" -C "$WORK/ctl" 2>/dev/null || true
APP_SRC="$(find "$WORK/root" -type f -name ChatGPT -perm -u+x -printf '%h\n' 2>/dev/null | head -1)"
[ -n "$APP_SRC" ] && [ -f "$APP_SRC/resources/app.asar" ] || die "El .deb no tiene la estructura esperada (binario ChatGPT + resources/app.asar)."
NEW_VER="$(sed -n 's/^AppVersion=//p' "$APP_SRC/resources/owl-app.ini" 2>/dev/null | head -1)"
info "versión de la app extraída: ${NEW_VER:-desconocida}"

# ---------------------------------------------------------------- 3. librerías del sistema que pide Electron
step "Librerías del sistema para la app"
install_runtime_libs() {
  [ "$SKIP_DEPS" -eq 0 ] || return 0
  if [ "$PM" = "apt-get" ] && [ -f "$WORK/ctl/control" ]; then
    local deps dep alt pick missing=()
    deps="$(sed -n 's/^Depends: //p' "$WORK/ctl/control" | tr ',' '\n')"
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      pick=""
      IFS='|' read -ra alts <<< "$dep"
      for alt in "${alts[@]}"; do
        alt="$(echo "$alt" | sed 's/([^)]*)//; s/^ *//; s/ *$//')"
        [ -n "$alt" ] || continue
        if dpkg -s "$alt" >/dev/null 2>&1; then pick="installed"; break; fi
        if [ -n "$(dpkg -l 2>/dev/null | awk -v a="$alt" '$1=="ii" && $2 ~ ("^" a "(:|$)") {print 1; exit}' || true)" ]; then pick="installed"; break; fi
      done
      if [ -z "$pick" ]; then
        for alt in "${alts[@]}"; do
          alt="$(echo "$alt" | sed 's/([^)]*)//; s/^ *//; s/ *$//')"
          if apt-get install -s "$alt" >/dev/null 2>&1; then missing+=("$alt"); pick="$alt"; break; fi
          # paquete virtual (p. ej. libasound2 -> libasound2t64 en Ubuntu 24.04): usar quien lo provee
          provs="$(apt-cache showpkg "$alt" 2>/dev/null | awk '/^Reverse Provides:/{f=1;next} f&&NF{print $1}' || true)"
          prov="$(printf '%s\n' "$provs" | grep "^$alt" | head -1 || true)"; [ -n "$prov" ] || prov="$(printf '%s\n' "$provs" | head -1 || true)"
          if [ -n "$prov" ] && apt-get install -s "$prov" >/dev/null 2>&1; then
            dpkg -s "$prov" >/dev/null 2>&1 || missing+=("$prov"); pick="$prov"; break
          fi
        done
        [ -n "$pick" ] || warn "No encuentro ningún paquete para la dependencia: $dep"
      fi
    done <<< "$deps"
    if [ "${#missing[@]}" -gt 0 ]; then info "instalando: ${missing[*]}"; pm_install "${missing[@]}" || warn "Alguna librería no se pudo instalar."; else info "todas las dependencias del .deb ya están instaladas ✓"; fi
  elif [ -n "$PM" ]; then
    local p todo=()
    for p in $(runtime_pkgs); do
      case "$PM" in
        pacman) pacman -Qq "$p" >/dev/null 2>&1 || todo+=("$p") ;;
        *)      rpm -q "$p" >/dev/null 2>&1 || todo+=("$p") ;;
      esac
    done
    if [ "${#todo[@]}" -gt 0 ]; then info "instalando: ${todo[*]}"; pm_install "${todo[@]}" || warn "Alguna librería no se pudo instalar; se comprobará con ldd."
    else info "todas las librerías ya están instaladas ✓"; fi
  fi
}
install_runtime_libs

check_ldd() {
  have ldd || return 0
  local miss
  miss="$( { ldd "$1" 2>/dev/null; for f in "$1"/../*.so*; do [ -f "$f" ] && LD_LIBRARY_PATH="$(dirname "$1")" ldd "$f" 2>/dev/null; done; } | sed -n 's/^[[:space:]]*\(.*\) => not found.*/\1/p' | sort -u )"
  if [ -n "$miss" ]; then warn "Librerías que siguen sin encontrarse:"; echo "$miss" | sed 's/^/        /' >&2; return 1; fi
  return 0
}
LDD_OK=1
LD_LIBRARY_PATH="$APP_SRC${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" check_ldd "$APP_SRC/ChatGPT" && info "ldd: no falta ninguna librería ✓" || LDD_OK=0

# ---------------------------------------------------------------- 4. copiar la app + componentes
step "Instalando en $PREFIX"
mkdir -p "$PREFIX"
# conservar lo que el usuario/ la app ya tenía (proxy y su config) y pisar solo lo de la app
cp -a "$APP_SRC/." "$PREFIX/"
cp -f "$APP_SRC/resources/app.asar" "$PREFIX/resources/app.asar.orig"   # base limpia para los parches
chmod u+w "$PREFIX/resources/app.asar" "$PREFIX/resources/app.asar.orig" 2>/dev/null || true

# Si se ejecuta con "curl | bash" no hay carpetas hermanas: bajar el repo.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ ! -f "$SRC_DIR/modelhub/patch_ui.py" ]; then
  info "descargando los componentes de https://github.com/$REPO ..."
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$WORK" || die "No se pudo bajar el repositorio."
  SRC_DIR="$WORK/$(basename "$REPO")-main"
fi
for d in modelhub mastermcp bin remote; do rm -rf "$PREFIX/$d"; cp -a "$SRC_DIR/$d" "$PREFIX/$d"; done
chmod +x "$PREFIX/bin/chatgpt2" "$PREFIX/modelhub/restart-clone.sh"
info "hub de modelos, Master MCP y lanzador copiados ✓"

# ---------------------------------------------------------------- 5. CLIProxyAPI
step "CLIProxyAPI v$CPA_VERSION (proxy de modelos)"
CPA_TAR="CLIProxyAPI_${CPA_VERSION}_linux_${ARCH_CPA}.tar.gz"
CPA_BASE="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CPA_VERSION}"
mkdir -p "$PREFIX/cliproxyapi"
if [ ! -x "$PREFIX/cliproxyapi/cli-proxy-api" ]; then
  curl -fL --retry 3 --progress-bar -o "$WORK/$CPA_TAR" "$CPA_BASE/$CPA_TAR" || die "No se pudo descargar CLIProxyAPI."
  curl -fsSL --retry 3 -o "$WORK/cpa-checksums.txt" "$CPA_BASE/checksums.txt" || die "No se pudo descargar checksums.txt de CLIProxyAPI."
  WANT_CPA="$(grep " $CPA_TAR\$" "$WORK/cpa-checksums.txt" | cut -d' ' -f1)"
  [ -n "$WANT_CPA" ] && [ "$(sha_of "$WORK/$CPA_TAR")" = "$WANT_CPA" ] || die "SHA-256 de CLIProxyAPI no coincide."
  info "SHA-256 verificado ✓"
  mkdir -p "$WORK/cpa" && tar -xzf "$WORK/$CPA_TAR" -C "$WORK/cpa"
  CPA_BIN_SRC="$(find "$WORK/cpa" -type f -name cli-proxy-api | head -1)"
  [ -n "$CPA_BIN_SRC" ] || die "El paquete de CLIProxyAPI no trae el binario cli-proxy-api."
  install -m 755 "$CPA_BIN_SRC" "$PREFIX/cliproxyapi/cli-proxy-api"
else
  info "ya instalado ✓"
fi

# ---------------------------------------------------------------- 6. parches + hub
step "Configurando el hub y aplicando los parches a la interfaz"
export CHATGPT2_HOME="$PREFIX"
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex-2}"
python3 -I "$PREFIX/modelhub/modelhub.py" init
if python3 -I "$PREFIX/modelhub/patch_ui.py"; then
  info "parches aplicados ✓"
else
  warn "Los parches NO encajaron con la versión ${NEW_VER:-?} de la app (OpenAI cambió su código)."
  warn "La app queda sin parches (sin 'Modelos personalizados' ni 'ChatGPT Web'). Usa la versión probada: --version $APP_VERSION_TESTED"
fi
[ "$NODE_OK" -eq 1 ] || rm -rf "$PREFIX/mastermcp/host.cjs" "$PREFIX/remote"
rm -rf "$PREFIX/resources/app-src"

# ---------------------------------------------------------------- 7. comando y menú
step "Creando el comando y el acceso directo"
mkdir -p "$HOME/.local/bin"
ln -sf "$PREFIX/bin/chatgpt2" "$HOME/.local/bin/chatgpt2"
info "comando: ~/.local/bin/chatgpt2"
if [ "$NO_MENU" -eq 0 ]; then
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat > "$APPS/chatgpt2.desktop" <<EOF
[Desktop Entry]
Name=ChatGPT 2
Comment=ChatGPT/Codex con hub de modelos propio (segunda cuenta)
GenericName=AI assistant
Exec=$HOME/.local/bin/chatgpt2 %U
Icon=$PREFIX/resources/icon-chatgpt.png
Type=Application
StartupNotify=true
StartupWMClass=ChatGPT 2
Categories=Utility;Development;
EOF
  have update-desktop-database && update-desktop-database "$APPS" >/dev/null 2>&1 || true
  info "acceso en el menú de aplicaciones: «ChatGPT 2»"
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "~/.local/bin no está en tu PATH: añade  export PATH=\"\$HOME/.local/bin:\$PATH\"  a tu shell, o abre la app desde el menú.";; esac

step "Listo"
cat <<EOF
    Instalado en:   $PREFIX
    Datos propios:  $CODEX_HOME  y  ~/.config/Codex-2   (separados de tu Codex normal)
    Abrir:          chatgpt2        (o «ChatGPT 2» en el menú)

    Siguiente paso: abre la app → Ajustes → «Modelos personalizados» → Cuentas → conecta Antigravity / Claude / ChatGPT.
    Guía completa en el README.
EOF
[ "$LDD_OK" -eq 1 ] || warn "Revisa las librerías que faltan (arriba) antes de abrir la app."
}
main "$@"

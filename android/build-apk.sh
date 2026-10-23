#!/usr/bin/env bash
# Compila ChatGPT 2 Remote (APK) sin Gradle: solo el SDK de Android (build-tools 35, android-35) y un JDK 17+.
# Uso: ./build-apk.sh        -> dist/chatgpt2-remote.apk (firmado con TU clave local, que se crea la primera vez)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
PLATFORM="$SDK/platforms/android-35/android.jar"
OUT="$ROOT/build"
APK="${CHATGPT2_REMOTE_APK:-$ROOT/dist/chatgpt2-remote.apk}"
ZXING="$ROOT/.tools/zxing-core-3.5.3.jar"
ZXING_SHA256="8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82"
for t in "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/apksigner" "$PLATFORM"; do [ -e "$t" ] || { echo "Falta $t (instala build-tools;35.0.0 y platforms;android-35 con sdkmanager)." >&2; exit 1; }; done
mkdir -p "$OUT/classes" "$OUT/res" "$OUT/dex" "$ROOT/dist"
if [ ! -f "$ZXING" ]; then
  mkdir -p "$(dirname "$ZXING")"
  curl --fail --location --silent --show-error --output "$ZXING" "https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar"
fi
echo "$ZXING_SHA256  $ZXING" | sha256sum --check --status || { echo "El SHA-256 de zxing no coincide." >&2; exit 1; }
"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/res" -o "$OUT/res/resources.zip"
mapfile -d '' sources < <(find "$ROOT/src" -name '*.java' -print0)
javac --release 8 -classpath "$PLATFORM:$ZXING" -d "$OUT/classes" "${sources[@]}"
mapfile -d '' classes < <(find "$OUT/classes" -name '*.class' -print0)
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 26 --output "$OUT/dex" "$ZXING" "${classes[@]}"
"$BUILD_TOOLS/aapt2" link -I "$PLATFORM" --manifest "$ROOT/AndroidManifest.xml" --min-sdk-version 26 --target-sdk-version 35 -A "$ROOT/assets" -o "$OUT/unsigned.apk" "$OUT/res/resources.zip"
"$BUILD_TOOLS/aapt" add -k "$OUT/unsigned.apk" "$OUT/dex/classes.dex" >/dev/null
# Clave de firma propia: se genera una vez con contraseña aleatoria y se guarda con permisos 0600.
KEY="${CHATGPT2_REMOTE_KEYSTORE:-${XDG_CACHE_HOME:-$HOME/.cache}/chatgpt2/android-remote.keystore}"
PASSFILE="$KEY.pass"
if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$PASSFILE"; chmod 600 "$PASSFILE"
  keytool -genkeypair -keystore "$KEY" -storepass "$(cat "$PASSFILE")" -keypass "$(cat "$PASSFILE")" -alias chatgpt2 -keyalg RSA -keysize 2048 -validity 9125 -dname 'CN=ChatGPT 2 Remote' >/dev/null
  chmod 600 "$KEY"
fi
PASS="$(cat "$PASSFILE")"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$KEY" --ks-key-alias chatgpt2 --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out "$APK" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --verbose "$APK" | head -3
echo "Creado $APK"

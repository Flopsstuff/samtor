#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${SAMTOR_DOOM_BUILD_DIR:-$PROJECT_ROOT/.build/doom}"
DOWNLOAD_DIR="$BUILD_ROOT/downloads"
INSTALLER_DIR="$BUILD_ROOT/doom-shareware"
WAD_DIR="$BUILD_ROOT/doom-wad"

DOOMGENERIC_COMMIT="dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284"
DOOMGENERIC_ARCHIVE_URL="https://codeload.github.com/ozkl/doomgeneric/tar.gz/$DOOMGENERIC_COMMIT"
DOOMGENERIC_ARCHIVE_SHA256="1bd3f7f26220494159a38d71f2847ec81b58d6bbd7c7c8d81b08993018001148"
SOURCE_DIR="$BUILD_ROOT/doomgeneric-$DOOMGENERIC_COMMIT"
EMSCRIPTEN_VERSION="6.0.9"

DOOM_ARCHIVE_URL="https://www.gamers.org/pub/idgames/idstuff/doom/doom19s.zip"
DOOM_ARCHIVE_SHA256="cacf0142b31ca1af00796b4a0339e07992ac5f21bc3f81e7532fe1b5e1b486e6"
DOOM_WAD_SHA256="1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771"

DGGUSPAT_ARCHIVE_URL="https://www.gamers.org/pub/idgames/music/dgguspat.zip"
DGGUSPAT_ARCHIVE_SHA256="63edb5ee92c007553d187bcee6fed7b5c8a886d25dbc01da5abe5cce14fb002f"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

verify_file() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(sha256_file "$path")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Checksum mismatch for %s\nExpected: %s\nActual:   %s\n' \
      "$path" "$expected" "$actual" >&2
    return 1
  fi
}

download() {
  local url="$1"
  local destination="$2"
  local checksum="$3"

  if [[ -f "$destination" ]] && verify_file "$destination" "$checksum"; then
    return
  fi

  rm -f "$destination"
  curl --fail --location --retry 3 --output "$destination" "$url"
  verify_file "$destination" "$checksum"
}

for command in curl unzip unar make awk tar; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

if ! command -v emcc >/dev/null 2>&1; then
  EMSDK_ENV="${EMSDK_ENV:-$HOME/emsdk/emsdk_env.sh}"
  if [[ ! -f "$EMSDK_ENV" ]]; then
    printf 'emcc was not found. Install emsdk or set EMSDK_ENV.\n' >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$EMSDK_ENV"
fi

command -v emmake >/dev/null 2>&1 || {
  printf 'emmake was not found after loading emsdk.\n' >&2
  exit 1
}

EMCC_VERSION_OUTPUT="$(emcc --version | awk 'NR == 1')"
if [[ "$EMCC_VERSION_OUTPUT" != *" $EMSCRIPTEN_VERSION "* ]]; then
  printf 'Emscripten %s is required; found: %s\n' \
    "$EMSCRIPTEN_VERSION" "$EMCC_VERSION_OUTPUT" >&2
  printf 'Run: emsdk install %s && emsdk activate %s\n' \
    "$EMSCRIPTEN_VERSION" "$EMSCRIPTEN_VERSION" >&2
  exit 1
fi

mkdir -p "$DOWNLOAD_DIR"
download "$DOOMGENERIC_ARCHIVE_URL" \
  "$DOWNLOAD_DIR/doomgeneric-$DOOMGENERIC_COMMIT.tar.gz" \
  "$DOOMGENERIC_ARCHIVE_SHA256"
download "$DOOM_ARCHIVE_URL" "$DOWNLOAD_DIR/doom19s.zip" "$DOOM_ARCHIVE_SHA256"
download "$DGGUSPAT_ARCHIVE_URL" "$DOWNLOAD_DIR/dgguspat.zip" "$DGGUSPAT_ARCHIVE_SHA256"

rm -rf "$SOURCE_DIR" "$INSTALLER_DIR" "$WAD_DIR"
tar -xzf "$DOWNLOAD_DIR/doomgeneric-$DOOMGENERIC_COMMIT.tar.gz" -C "$BUILD_ROOT"

mkdir -p "$INSTALLER_DIR" "$WAD_DIR"
unzip -q "$DOWNLOAD_DIR/doom19s.zip" -d "$INSTALLER_DIR"
cat "$INSTALLER_DIR/DOOMS_19.1" "$INSTALLER_DIR/DOOMS_19.2" \
  > "$INSTALLER_DIR/DOOMS_19.EXE"
unar -q -f -o "$WAD_DIR" "$INSTALLER_DIR/DOOMS_19.EXE"

WAD_PATH="$WAD_DIR/DOOMS_19/DOOM1.WAD"
verify_file "$WAD_PATH" "$DOOM_WAD_SHA256"

ENGINE_DIR="$SOURCE_DIR/doomgeneric"
cp "$WAD_PATH" "$ENGINE_DIR/doom1.wad"
mkdir "$ENGINE_DIR/dgguspat"
unzip -q "$DOWNLOAD_DIR/dgguspat.zip" -d "$ENGINE_DIR/dgguspat"
{
  printf 'dir /dgguspat\n'
  cat "$ENGINE_DIR/dgguspat/timidity.cfg"
} > "$ENGINE_DIR/timidity.cfg"

CFLAGS="-O2 -fcommon \
-Wno-implicit-function-declaration -Wno-int-conversion \
-Wno-incompatible-pointer-types -Wno-implicit-int \
-Wno-deprecated-non-prototype -Wno-return-type -Wno-absolute-value \
-DFEATURE_SOUND -sUSE_SDL=2 -sUSE_SDL_MIXER=2 \
-sSDL2_MIXER_FORMATS='[\"mid\"]'"

LDFLAGS="--preload-file doom1.wad --preload-file timidity.cfg \
--preload-file dgguspat -sUSE_SDL=2 -sUSE_SDL_MIXER=2 \
-sSDL2_MIXER_FORMATS='[\"mid\"]' -sMIN_CHROME_VERSION=85 \
-sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS='[\"callMain\"]'"

(
  cd "$ENGINE_DIR"
  emmake make -f Makefile.emscripten clean
  emmake make -f Makefile.emscripten \
    CFLAGS="$CFLAGS" \
    LDFLAGS="$LDFLAGS" \
    LIBS="-lm -lc"
)

install -m 0644 "$ENGINE_DIR/doomgeneric.js" "$SCRIPT_DIR/doomgeneric.js"
install -m 0644 "$ENGINE_DIR/doomgeneric.wasm" "$SCRIPT_DIR/doomgeneric.wasm"
install -m 0644 "$ENGINE_DIR/doomgeneric.data" "$SCRIPT_DIR/doomgeneric.data"

printf 'Doom assets built in %s\n' "$SCRIPT_DIR"

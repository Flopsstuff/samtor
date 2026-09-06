#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f LICENSE ]] || fail "LICENSE is missing"
grep -q "MIT License" LICENSE || fail "LICENSE is not MIT"
[[ -f THIRD_PARTY_NOTICES.md ]] || fail "THIRD_PARTY_NOTICES.md is missing"

[[ -x Doom/build.sh ]] || fail "Doom/build.sh is missing or not executable"
bash -n Doom/build.sh

grep -q "dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284" Doom/build.sh ||
  fail "doomgeneric revision is not pinned"
grep -q "1bd3f7f26220494159a38d71f2847ec81b58d6bbd7c7c8d81b08993018001148" Doom/build.sh ||
  fail "doomgeneric source archive checksum is missing"
grep -q 'EMSCRIPTEN_VERSION="6.0.9"' Doom/build.sh ||
  fail "Emscripten version is not pinned"
grep -q "cacf0142b31ca1af00796b4a0339e07992ac5f21bc3f81e7532fe1b5e1b486e6" Doom/build.sh ||
  fail "DOOM shareware archive checksum is missing"
grep -q "63edb5ee92c007553d187bcee6fed7b5c8a886d25dbc01da5abe5cce14fb002f" Doom/build.sh ||
  fail "dgguspat archive checksum is missing"

for artifact in Doom/doomgeneric.js Doom/doomgeneric.wasm Doom/doomgeneric.data; do
  if git ls-files --error-unmatch "$artifact" >/dev/null 2>&1; then
    fail "$artifact must not be tracked"
  fi
  git check-ignore -q "$artifact" || fail "$artifact must be ignored"
done

grep -q "https://www.gamers.org/pub/idgames/idstuff/doom/doom19s.zip" README.md ||
  fail "README does not link the DOOM shareware archive"
grep -q "https://www.gamers.org/pub/idgames/music/dgguspat.zip" README.md ||
  fail "README does not link the dgguspat archive"

printf 'Public Doom checks passed.\n'

#!/usr/bin/env bash
# Copy the pairing client into a Tizen application directory.
#
#   ./pairing/client/install.sh Bench
#
# Both files are copied rather than referenced: a .wgt is built from a single
# directory, so an application has to be self-contained. Re-run this after
# changing remote-config.js to refresh the copies.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-}"

if [ -z "$target" ] || [ ! -d "$target" ]; then
  echo "usage: $0 <application directory>" >&2
  exit 1
fi

cp "$here/remote-config.js" "$here/qrcode.js" "$target/"
echo "copied remote-config.js and qrcode.js into $target/"

cat <<'NOTE'

Still to do by hand in that application:

  1. config.xml — add the internet privilege and an <access> element:

       <tizen:privilege name="http://tizen.org/privilege/internet"/>
       <access origin="https://YOUR-PAIRING-HOST" subdomains="true"/>

     Without <access> every fetch fails while WebSocket still works, which
     makes the cause very hard to see.

  2. index.html — load both files before your own script:

       <script src="qrcode.js"></script>
       <script src="remote-config.js"></script>

  3. Point it at a deployment. Keep the host out of version control if the
     repository is public; see Bench/local-config.example.js.
NOTE

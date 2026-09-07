#!/usr/bin/env bash
# Copy the pairing clients into a Tizen application directory.
#
#   ./pairing/client/install.sh Bench                # both clients
#   ./pairing/client/install.sh Bench config         # one-off setup only
#   ./pairing/client/install.sh Bench mirror         # the live form mirror only
#
# The files are copied rather than referenced: a .wgt is built from a single
# directory, so an application has to be self-contained. That is also why the QR
# drawing appears in both clients rather than in a third file. Re-run this after
# changing either one to refresh the copies.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-}"

if [ -z "$target" ] || [ ! -d "$target" ]; then
  echo "usage: $0 <application directory> [config|mirror ...]" >&2
  exit 1
fi

components=("${@:2}")
if [ ${#components[@]} -eq 0 ]; then components=(config mirror); fi

files=(qrcode.js)                       # the QR encoder both clients need
for component in "${components[@]}"; do
  case "$component" in
    config) files+=(remote-config.js) ;;
    mirror) files+=(remote-mirror.js) ;;
    *) echo "unknown component: $component (config|mirror)" >&2; exit 1 ;;
  esac
done

# The message is derived from the list, so the two cannot drift apart.
for file in "${files[@]}"; do cp "$here/$file" "$target/"; done
echo "copied ${files[*]} into $target/"

cat <<'NOTE'

Still to do by hand in that application:

  1. config.xml — add the internet privilege and an <access> element:

       <tizen:privilege name="http://tizen.org/privilege/internet"/>
       <access origin="https://YOUR-PAIRING-HOST" subdomains="true"/>

     Without <access> every fetch fails while WebSocket still works, which
     makes the cause very hard to see.

  2. index.html — load qrcode.js first, then whichever clients you copied:

       <script src="qrcode.js"></script>
       <script src="remote-config.js"></script>     <!-- one-off setup -->
       <script src="remote-mirror.js"></script>     <!-- live form mirror -->

     The two are independent; install either or both.

  3. Point it at a deployment. Keep the host out of version control if the
     repository is public; see Bench/local-config.example.js.

  4. For the mirror only: give the form onsubmit="return false" unless it really
     should navigate away, because a submit from a file: origin leaves the widget
     with nowhere to come back from. And read what onSkip reports once — a real
     form usually has a field or two the mirror refuses to carry, and it says
     which and why.
NOTE

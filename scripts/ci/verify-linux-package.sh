#!/usr/bin/env bash
set -euo pipefail
cd release
appimage="$(ls -- *.AppImage)"
deb="$(ls -- *.deb)"
entry="$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/applications/octogee.desktop)"
grep -Fx 'MimeType=x-scheme-handler/octogee;' <<<"$entry"
grep -Fx 'Exec=/opt/Octogee/octogee %U' <<<"$entry"
grep -F "url: ${appimage}" latest-linux.yml
grep -F "url: ${deb}" latest-linux.yml

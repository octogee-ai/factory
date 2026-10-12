#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/octo
export DISPLAY=:0 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox
export XDG_RUNTIME_DIR=/run/user/1000
export OCTO_COMPOSITOR=openbox OCTO_CHROMIUM_PLATFORM=x11 OCTO_BIND=127.0.0.1
export OCTO_HOME_URL=http://127.0.0.1:7777/desk OCTOGEE_X11_SESSION=1 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
export OCTO_PINNED_APPS=chromium:octogee-files:octogee-terminal:org.xfce.mousepad
unset WAYLAND_DISPLAY CUA_DRIVER_RS_ENABLE_WAYLAND
mkdir -p "$XDG_RUNTIME_DIR/octogee-openclaw-vnc" "$HOME/.config/octogee-chromium" "$HOME/.openclaw-desktop"
chmod 700 "$XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR/octogee-openclaw-vnc"
rm -f "$HOME/.config/octogee-chromium/SingletonLock" "$HOME/.config/octogee-chromium/SingletonSocket" "$HOME/.config/octogee-chromium/SingletonCookie"
exec dbus-run-session -- /usr/local/bin/octogee-hobby-session

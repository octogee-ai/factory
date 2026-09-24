#!/usr/bin/bash
set -euo pipefail

OMARCHY_VERSION="${OMARCHY_VERSION:?}"
IMAGE_NAME="${IMAGE_NAME:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLRCTL_REF="${WLRCTL_REF:-v0.2.2}"
NOVNC_VERSION="${NOVNC_VERSION:-1.7.0}"
NOVNC_SHA256="${NOVNC_SHA256:-b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6}"
WEBSOCKIFY_VERSION="${WEBSOCKIFY_VERSION:-0.13.0}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S) [customize]" "$*"; }

log "packages"
OMARCHY_ALLOW_DIRECT_PACMAN=1 pacman -Syu --noconfirm --needed \
  wayvnc x11vnc grim wtype wl-clipboard slurp jq python python-pip python-websocket-client bc \
  meson ninja wayland wayland-protocols libxkbcommon git \
  chromium xorg-xwayland noto-fonts noto-fonts-cjk noto-fonts-emoji ttf-jetbrains-mono >/tmp/pacman.log 2>&1 \
  || { tail -20 /tmp/pacman.log; exit 1; }

log "Omarchy migrations"
sudo -H -u octo bash -lc 'omarchy migrate'

log "wlrctl ${WLRCTL_REF}"
rm -rf /tmp/wlrctl
git -c advice.detachedHead=false clone -q --depth 1 --branch "$WLRCTL_REF" https://git.sr.ht/~brocellous/wlrctl /tmp/wlrctl
meson setup /tmp/wlrctl/build /tmp/wlrctl -Dman-pages=disabled --buildtype=release >/dev/null
ninja -C /tmp/wlrctl/build >/dev/null
install -m 0755 /tmp/wlrctl/build/wlrctl /usr/local/bin/wlrctl
bash "$HERE/desktop-rootfs/usr/share/omarchy/octo-desktop/build-seat-input.sh" \
  /tmp/wlrctl/protocol/virtual-keyboard-unstable-v1.xml /usr/local/bin/octo-seat-input
rm -rf /tmp/wlrctl

log "novnc ${NOVNC_VERSION} + websockify ${WEBSOCKIFY_VERSION}"
curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" -o /tmp/novnc.tgz
printf '%s  %s\n' "$NOVNC_SHA256" /tmp/novnc.tgz | sha256sum -c --quiet -
rm -rf /opt/novnc && mkdir -p /opt/novnc
tar -xzf /tmp/novnc.tgz -C /opt/novnc --strip-components=1
rm -f /tmp/novnc.tgz
pip install --quiet --break-system-packages --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}"

log "desktop session files"
cp -R --no-preserve=all "$HERE/desktop-rootfs/." /
cp -R --no-preserve=all "$HERE/rootfs/." /
chown -R root:root /usr/local/bin/octo-shims /usr/share/omarchy/octo-desktop /etc/systemd/system/octo-*.service /etc/systemd/system/octo-*.timer /etc/systemd/logind.conf.d/octo-desktop.conf /etc/modules-load.d/octo-desktop.conf /etc/sudoers.d/octo-desktop /usr/local/bin/octo-desktop-* /usr/local/bin/octo-metadata-ssh-keys
chmod 0755 /usr/local/bin/octo-desktop-* /usr/local/bin/octo-shims/* /usr/local/bin/octo-metadata-ssh-keys /usr/local/bin/octo-gateway-agent /usr/local/bin/octo-gateway-firewall /usr/local/bin/octo-grow-root /usr/local/bin/octo-home-disk
chmod 0440 /etc/sudoers.d/octo-desktop
rm -f /etc/sudoers.d/zz-octo-nopasswd
visudo -cf /etc/sudoers.d/octo-desktop >/dev/null

log "boot: limine timeout, machine identity, services"
sed -i -E 's/^#?timeout:.*/timeout: 0/' /boot/limine.conf
grep -q '^timeout: 0' /boot/limine.conf || printf 'timeout: 0\n' >> /boot/limine.conf
sed -i -E '/^[[:space:]]*cmdline:/ { s/ resume=[^ ]+ resume_offset=[0-9]+//; s/ quiet splash loglevel=0 systemd\.show_status=false rd\.udev\.log_level=0 vt\.global_cursor_default=0//; /console=ttyS0/! s/$/ console=tty0 console=ttyS0,115200n8 loglevel=4/ }' /boot/limine.conf
systemctl unmask NetworkManager-wait-online.service
loginctl enable-linger octo
systemctl enable octo-grow-root.service octo-home-disk.service octo-seatd.service octo-desktop.service octo-desktop-lifecycle.service octo-metadata-ssh-keys.timer octo-gateway-agent.service sshd.service NetworkManager.service NetworkManager-wait-online.service docker.service
systemctl disable sddm.service
systemctl mask sddm.service
systemctl disable --now cups.service cups.path avahi-daemon.service bluetooth.service >/dev/null 2>&1 || true

log "identity reset + cleanup"
printf '%s\n' "$IMAGE_NAME" > /etc/octogee-computer-image
printf 'OMARCHY_VERSION=%s\nIMAGE_NAME=%s\n' "$OMARCHY_VERSION" "$IMAGE_NAME" > /etc/octogee-computer.env
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
pacman -Scc --noconfirm >/dev/null 2>&1 || true
rm -rf /var/log/journal/* /home/octo/.cache/hyprland /home/octo/.local/state/octo-desktop /tmp/pacman.log
log "done: $(cat /etc/octogee-computer-image)"

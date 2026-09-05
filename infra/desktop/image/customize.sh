#!/usr/bin/bash
set -euo pipefail

OMARCHY_VERSION="${OMARCHY_VERSION:?}"
IMAGE_NAME="${IMAGE_NAME:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLRCTL_REF="${WLRCTL_REF:-v0.2.2}"
NOVNC_VERSION="${NOVNC_VERSION:-1.6.0}"
NOVNC_SHA256="${NOVNC_SHA256:-5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa}"
WEBSOCKIFY_VERSION="${WEBSOCKIFY_VERSION:-0.13.0}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S) [customize]" "$*"; }

log "packages"
pacman -Sy --noconfirm --needed \
  wayvnc grim wtype wl-clipboard slurp jq python python-pip bc \
  meson ninja wayland wayland-protocols libxkbcommon git \
  chromium xorg-xwayland noto-fonts noto-fonts-emoji ttf-jetbrains-mono >/tmp/pacman.log 2>&1 \
  || { tail -20 /tmp/pacman.log; exit 1; }

log "wlrctl ${WLRCTL_REF}"
rm -rf /tmp/wlrctl
git -c advice.detachedHead=false clone -q --depth 1 --branch "$WLRCTL_REF" https://git.sr.ht/~brocellous/wlrctl /tmp/wlrctl
meson setup /tmp/wlrctl/build /tmp/wlrctl -Dman-pages=disabled --buildtype=release >/dev/null
ninja -C /tmp/wlrctl/build >/dev/null
install -m 0755 /tmp/wlrctl/build/wlrctl /usr/local/bin/wlrctl
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
chmod 0755 /usr/local/bin/octo-desktop-* /usr/local/bin/octo-shims/* /usr/local/bin/octo-metadata-ssh-keys
chmod 0440 /etc/sudoers.d/octo-desktop
rm -f /etc/sudoers.d/zz-octo-nopasswd
visudo -cf /etc/sudoers.d/octo-desktop >/dev/null

log "boot: limine timeout, machine identity, services"
sed -i -E 's/^#?timeout:.*/timeout: 0/' /boot/limine.conf
grep -q '^timeout: 0' /boot/limine.conf || printf 'timeout: 0\n' >> /boot/limine.conf
sed -i -E '/^[[:space:]]*cmdline:/ { s/ resume=[^ ]+ resume_offset=[0-9]+//; s/ quiet splash loglevel=0 systemd\.show_status=false rd\.udev\.log_level=0 vt\.global_cursor_default=0//; /console=ttyS0/! s/$/ console=tty0 console=ttyS0,115200n8 loglevel=4/ }' /boot/limine.conf
systemctl unmask NetworkManager-wait-online.service
systemctl enable octo-seatd.service octo-desktop.service octo-metadata-ssh-keys.timer sshd.service NetworkManager.service NetworkManager-wait-online.service docker.service
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

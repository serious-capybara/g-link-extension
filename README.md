# G-Link for GNOME

A GNOME Shell extension (`glink@glink.local`) that connects a Fedora/Wayland desktop to the **G-Link Android app**.
Forked from [GSConnect](https://github.com/GSConnect/gnome-shell-extension-gsconnect); original copyright notices
are preserved under the GPL.

## Features
- Device pairing, notifications, clipboard, file sharing, SMS, media and input control (inherited plugin set).
- **Remote desktop (planned):** D-Bus integration to toggle GNOME Remote Desktop (GRD) so the Android app can
  view the Wayland session over RDP. GRD exposes its RDP server on the session bus
  (`org.gnome.RemoteDesktop`); confirm the exact object/properties on your Fedora release with
  `busctl --user introspect org.gnome.RemoteDesktop /org/gnome/RemoteDesktop/Rdp/Server`.
- **Faster transfers (planned):** optimized payload handling (larger buffers, fewer copies) for big files.

## Identifiers
| Item | Value |
|---|---|
| Extension UUID | `glink@glink.local` |
| GSettings schema | `org.gnome.Shell.Extensions.GLink` |
| D-Bus service / paths | `org.gnome.Shell.Extensions.GLink`, `/org/gnome/Shell/Extensions/GLink` |
| Wire protocol | `glink.*` packets, protocol version 8, TCP/UDP 1716 |

## Build & install (dev)
```bash
meson setup _build && meson compile -C _build   # see meson_options.txt for the install-dir option
gnome-extensions enable glink@glink.local
journalctl -f -o cat /usr/bin/gnome-shell        # watch for errors
```

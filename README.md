# G-Link for GNOME

A GNOME Shell extension (`glink@serious-capybara`) that connects a Fedora/Wayland desktop to the **G-Link Android app**.
Forked from [GSConnect](https://github.com/GSConnect/gnome-shell-extension-gsconnect); original copyright notices
are preserved under the GPL.

Source: https://github.com/serious-capybara/g-link-extension  ·  Android app: https://github.com/serious-capybara/g-link-app

## Features
- Device pairing, notifications, clipboard, file sharing, SMS, media and input control (inherited plugin set).
- **Remote desktop:** the `rdp` plugin (off by default, enable it per device) starts GNOME Remote Desktop view-only with
  random one-time credentials when the phone asks (`glink.rdp.request` / `glink.rdp.response`), and stops it on request,
  after 30 minutes, or when the phone disconnects. Needs `gnome-remote-desktop`, `openssl`, and TCP 3389 open in the firewall.
  GRD integration: GRD exposes its RDP server on the session bus
  (`org.gnome.RemoteDesktop`); confirm the exact object/properties on your Fedora release with
  `busctl --user introspect org.gnome.RemoteDesktop /org/gnome/RemoteDesktop/Rdp/Server`.
- **Faster transfers:** 256 KiB chunked pump with overlapped read/write instead of 8 KiB `splice`, size-based socket
  buffers, TCP_NODELAY, and MiB/s progress in the debug log.
- **Faster discovery:** mDNS via Avahi (`_glink._udp`) next to the UDP broadcast, with a 3-packet burst on network changes.

## Identifiers
| Item | Value |
|---|---|
| Extension UUID | `glink@serious-capybara` |
| GSettings schema | `org.gnome.Shell.Extensions.GLink` |
| D-Bus service / paths | `org.gnome.Shell.Extensions.GLink`, `/org/gnome/Shell/Extensions/GLink` |
| Wire protocol | `glink.*` packets, protocol version 8, UDP 2064 (discovery), TCP 2064-2128 (link), TCP 2096-2128 (file transfer / SFTP) |

## Build & install (dev)
```bash
meson setup _build && meson compile -C _build   # see meson_options.txt for the install-dir option
gnome-extensions enable glink@serious-capybara
journalctl -f -o cat /usr/bin/gnome-shell        # watch for errors
```

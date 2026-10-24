#!/usr/bin/env bash
# G-Link GNOME extension installer.
#
#   bash install.sh            install from this folder (or download it if run on its own)
#   bash install.sh --deps     also install optional packages with dnf (asks for sudo)
#
# Installs into  $HOME/.local/share/gnome-shell/extensions/<uuid>  (works for any user name).
set -euo pipefail

REPO_URL="https://github.com/serious-capybara/g-link-extension"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
OLD_UUIDS=("glink@glink.local" "g-link@glink.org" "glink@serious-capybara")   # earlier names, removed so GNOME never loads two copies

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

INSTALL_DEPS=0
[[ "${1:-}" == "--deps" ]] && INSTALL_DEPS=1

# --- 1. find the source: this folder if it is the extension, otherwise download it
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP=""
if [[ -f "$HERE/metadata.json" && -f "$HERE/extension.js" ]]; then
    SRC="$HERE"
else
    say "Downloading G-Link from $REPO_URL"
    TMP="$(mktemp -d)"; CLEANUP="$TMP"
    if command -v git >/dev/null 2>&1; then
        git clone --depth 1 "$REPO_URL" "$TMP/src"
    else
        command -v curl >/dev/null 2>&1 || { warn "Need git or curl to download."; exit 1; }
        curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP"
        mv "$TMP"/g-link-extension-* "$TMP/src"
    fi
    SRC="$TMP/src"
fi
trap '[[ -n "$CLEANUP" ]] && rm -rf "$CLEANUP"' EXIT

# --- 2. the extension ID comes from metadata.json, so the folder name always matches it
UUID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['uuid'])" "$SRC/metadata.json")"
DEST="$EXT_DIR/$UUID"
say "Installing $UUID into $DEST"

mkdir -p "$EXT_DIR"
for old in "${OLD_UUIDS[@]}"; do
    [[ -d "$EXT_DIR/$old" ]] && { say "Removing old copy: $old"; rm -rf "${EXT_DIR:?}/$old"; }
done
rm -rf "$DEST"
mkdir -p "$DEST"
tar -C "$SRC" --exclude=.git --exclude=install.sh --exclude=g-link.gresource.xml -cf - . | tar -C "$DEST" -xf -
chmod +x "$DEST/service/daemon.js" "$DEST/g-link-preferences" 2>/dev/null || true

# --- 3. make sure resources and schema are compiled, and DBus/Desktop/Icon files installed
if command -v glib-compile-resources >/dev/null 2>&1; then
    glib-compile-resources --target="$DEST/org.gnome.Shell.Extensions.GLink.gresource" --sourcedir="$SRC" "$SRC/g-link.gresource.xml" 2>/dev/null || warn "Could not compile gresource."
fi
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$DEST/schemas" 2>/dev/null || warn "Could not compile the settings schema."
fi

# Install DBus service, Desktop entries, and Icons
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

mkdir -p "$DBUS_DIR" "$APP_DIR" "$ICON_DIR"

sed "s|@PACKAGE_DATADIR@|$DEST|g" "$SRC/org.gnome.Shell.Extensions.GLink.service.in" > "$DBUS_DIR/org.gnome.Shell.Extensions.GLink.service"
sed "s|@PACKAGE_DATADIR@|$DEST|g" "$SRC/org.gnome.Shell.Extensions.GLink.desktop" > "$APP_DIR/org.gnome.Shell.Extensions.GLink.desktop" 2>/dev/null || cp "$SRC/org.gnome.Shell.Extensions.GLink.desktop" "$APP_DIR/"
sed "s|@PACKAGE_DATADIR@|$DEST|g" "$SRC/org.gnome.Shell.Extensions.GLink.Preferences.desktop" > "$APP_DIR/org.gnome.Shell.Extensions.GLink.Preferences.desktop" 2>/dev/null || cp "$SRC/org.gnome.Shell.Extensions.GLink.Preferences.desktop" "$APP_DIR/"

cp "$SRC/icons/org.gnome.Shell.Extensions.GLink.svg" "$ICON_DIR/" 2>/dev/null || true
cp "$SRC/icons/org.gnome.Shell.Extensions.GLink-symbolic.svg" "$ICON_DIR/" 2>/dev/null || true

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true
fi
if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
fi

# --- 4. optional packages
if command -v openssl >/dev/null 2>&1; then :; else
    warn "openssl is missing (needed for pairing). Install it:  sudo dnf install openssl"
fi
if [[ $INSTALL_DEPS -eq 1 ]]; then
    if command -v dnf >/dev/null 2>&1; then
        say "Installing optional packages (screen sharing, clipboard, discovery)"
        sudo dnf install -y openssl avahi gnome-remote-desktop wl-clipboard
    else
        warn "dnf not found; install openssl, avahi, gnome-remote-desktop and wl-clipboard with your package manager."
    fi
fi

# --- 5. switch it on for the next login (writes the enabled list; no log-out needed to do this part)
if command -v gsettings >/dev/null 2>&1; then
    python3 - "$UUID" 2>/dev/null <<'PY' || warn "Could not update the enabled list here; after logging in run: gnome-extensions enable $UUID"
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], text=True, stderr=subprocess.DEVNULL).strip()
current = ast.literal_eval(raw[4:].strip() if raw.startswith("@as") else raw)
if uuid not in current:
    current.append(uuid)
    subprocess.check_call(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(current)], stderr=subprocess.DEVNULL)
    print("enabled for next login")
else:
    print("already in the enabled list")
PY
fi

say "Done. Installed to: $DEST"
echo
echo "  1. Log out and log back in (on Wayland GNOME only loads new extensions at login)."
echo "  2. Open the Quick Settings panel (top-right) and click the G-Link tile."
echo "  3. Check it:   gnome-extensions info $UUID"
echo "  4. Errors:     journalctl -f -o cat /usr/bin/gnome-shell"

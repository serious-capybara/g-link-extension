// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

// Bootstrap
import * as Setup from './utils/setup.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GLinkExtensionPreferences extends ExtensionPreferences {
    constructor(metadata) {
        super(metadata);
        Setup.setup(this.path);
        Setup.ensurePermissions();
        Setup.installService();
    }

    fillPreferencesWindow(window) {
        const widget = new Adw.PreferencesPage();
        window.add(widget);

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            window.close();
        });

        const _launcher = Gio.SubprocessLauncher.new({flags: Gio.SubprocessFlags.NONE});
        _launcher.set_cwd(this.path);
        _launcher.spawnv(['gjs', '-m', 'g-link-preferences.js']);
    }
}

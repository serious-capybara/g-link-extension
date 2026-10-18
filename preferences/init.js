// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {setup, setupGettext} from '../utils/setup.js';


// Bootstrap
setup(GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])));
setupGettext();

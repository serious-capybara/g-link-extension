// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


/**
 * Some useful regex patterns
 */
const PATTERN_URL = new RegExp(
    '(?:^|\\s)(?:(?:https?|ftp):\\/\\/|www\\.|ftp\\.)(?:\\([-A-Z0-9+&@#\\/%=~_|$?!:,.]*\\)|[-A-Z0-9+&@#\\/%=~_|$?!:,.]|\\*[A-Z0-9])+(?:\\([-A-Z0-9+&@#\\/%=~_|$?!:,.]*\\)|[A-Z0-9+&@#\\/%=~_|$])',
    'im'
);


/**
 * Linkify text by wrapping URIs in `<a>` tags.
 *
 * @param {string} text - The text to linkify
 * @returns {string} - The linkified text, markup-escaped
 */
export function linkify(text) {
    if (!text)
        return '';

    const escaped = GLib.markup_escape_text(text, -1);

    return escaped.replace(PATTERN_URL, (uri) => {
        const space = (uri.startsWith(' ')) ? ' ' : '';
        uri = uri.trim();

        return `${space}<a href="${uri}">${uri}</a>`;
    });
}


/**
 * Resolve a list of URIs to local file paths or download them to a cache.
 *
 * @param {string[]} uris - A list of URIs to resolve
 * @param {Gio.Cancellable} [cancellable] - An optional cancellable
 * @returns {Promise<string[]>} - A list of absolute file paths
 */
export async function resolve(uris, cancellable = null) {
    const files = [];

    for (const uri of uris) {
        const file = Gio.File.new_for_uri(uri);

        // Local file
        if (file.is_native()) {
            files.push(file.get_path());

        // Remote file (TODO: download to cache)
        } else {
            debug(`skipping non-native URI: ${uri}`);
        }
    }

    return files;
}

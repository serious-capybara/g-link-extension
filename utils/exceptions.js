// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

export class MissingOpensslError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MissingOpensslError';
    }
}

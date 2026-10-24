// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Ping'),
    description: _('Send and receive pings'),
    id: 'org.gnome.Shell.Extensions.GLink.Plugin.Ping',
    incomingCapabilities: ['glink.ping'],
    outgoingCapabilities: ['glink.ping'],
    actions: {
        ping: {
            label: _('Ping'),
            icon_name: 'dialog-information-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['glink.ping'],
        },
    },
};


/**
 * Ping Plugin
 * https://github.com/G-Link/glink-kde/tree/master/plugins/ping
 */
const PingPlugin = GObject.registerClass({
    GTypeName: 'GLinkPingPlugin',
}, class PingPlugin extends Plugin {

    _init(device) {
        super._init(device, 'ping');
    }

    handlePacket(packet) {
        // Notification
        const notif = {
            title: this.device.name,
            body: _('Ping'),
            icon: new Gio.ThemedIcon({name: `${this.device.icon_name}`}),
        };

        if (packet.body.message) {
            // TRANSLATORS: An optional message accompanying a ping, rarely if ever used
            // eg. Ping: A message sent with ping
            notif.body = _('Ping: %s').format(packet.body.message);
        }

        this.device.showNotification(notif);
    }

    ping(message = '') {
        const packet = {
            type: 'glink.ping',
            body: {},
        };

        if (message.length)
            packet.body.message = message;

        this.device.sendPacket(packet);
    }
});

export default PingPlugin;

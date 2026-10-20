// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/*
 * mDNS / DNS-SD for G-Link, via the Avahi daemon's D-Bus API (system bus).
 *
 * It does two things, mirroring Android's MdnsDiscovery.kt:
 *   - publish  `<deviceId>._glink._udp.local`  (port = our TCP port, TXT: id/name/type/protocol)
 *   - browse   `_glink._udp`, resolve every new service and hand (address, port, txt) to a callback
 *
 * Avahi is optional: if the daemon is not running (or not installed) everything here is a no-op and the
 * plain UDP broadcast keeps working. We watch the bus name, so discovery starts the moment Avahi appears
 * and recovers after `systemctl restart avahi-daemon`.
 *
 * Avahi D-Bus reference: https://github.com/avahi/avahi/blob/master/avahi-daemon/org.freedesktop.Avahi.*.xml
 */

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

export const SERVICE_TYPE = '_glink._udp';

const AVAHI_NAME = 'org.freedesktop.Avahi';
const SERVER_IFACE = 'org.freedesktop.Avahi.Server';
const GROUP_IFACE = 'org.freedesktop.Avahi.EntryGroup';
const BROWSER_IFACE = 'org.freedesktop.Avahi.ServiceBrowser';

const IF_UNSPEC = -1;
const PROTO_UNSPEC = -1;
const PROTO_INET = 0;   // IPv4. Android's UDP listener is IPv4 and so is its broadcast.

const CALL_TIMEOUT_MS = 3000;


/**
 * @param {Object<string, string>} record - TXT key/value pairs
 * @returns {number[][]} Avahi's `aay` TXT representation ("key=value" byte strings)
 */
function encodeTxt(record) {
    const enc = new TextEncoder();
    return Object.entries(record).map(([k, v]) => Array.from(enc.encode(`${k}=${v}`)));
}

function decodeTxt(aay) {
    const dec = new TextDecoder();
    const out = {};

    for (const bytes of aay) {
        const [key, ...rest] = dec.decode(Uint8Array.from(bytes)).split('=');
        out[key] = rest.join('=');
    }

    return out;
}


export class AvahiDiscovery {
    /**
     * @param {Object} params
     * @param {string} params.deviceId - our device ID (also our mDNS service name, so we can ignore ourselves)
     * @param {Function} params.onResolved - called as onResolved(address, port, txt) for each remote service
     */
    constructor({deviceId, onResolved}) {
        this._deviceId = deviceId;
        this._onResolved = onResolved;

        this._cancellable = new Gio.Cancellable();
        this._watchId = 0;
        this._available = false;
        this._generation = 0;      // bumped on every (re)start so stale async results are ignored

        this._publication = null;  // {port, txt} we want to advertise
        this._groupPath = null;
        this._browserPath = null;
        this._subscriptions = [];
        this._resolving = new Set();
    }

    /**
     * Begin watching for Avahi. Safe to call repeatedly.
     */
    start() {
        if (this._watchId !== 0)
            return;

        this._cancellable = new Gio.Cancellable();
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            AVAHI_NAME,
            Gio.BusNameWatcherFlags.NONE,
            this._onAppeared.bind(this),
            this._onVanished.bind(this)
        );
    }

    stop() {
        if (this._watchId !== 0) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }

        this._cancellable.cancel();
        this._teardown(true);
        this._available = false;
    }

    /**
     * Set (or change) what we advertise. Takes effect immediately if Avahi is up, otherwise when it appears.
     *
     * @param {number} port - our TCP listener port
     * @param {Object<string, string>} txt - TXT record (id, name, type, protocol)
     */
    publish(port, txt) {
        this._publication = {port, txt};

        if (this._available)
            this._restart();
    }

    /**
     * Re-announce and re-browse. Call after a network change: the interface set changed, so Avahi's old
     * registration may be on a dead interface, and a fresh browse makes it re-query immediately.
     */
    refresh() {
        if (this._available)
            this._restart();
    }

    _onAppeared() {
        this._available = true;
        debug('Avahi appeared, starting mDNS');
        this._restart();
    }

    _onVanished() {
        if (this._available)
            debug('Avahi vanished, mDNS paused (UDP broadcast still active)');

        this._available = false;
        this._generation++;
        this._teardown(false);
    }

    _restart() {
        this._teardown(false);
        const gen = ++this._generation;

        this._register(gen).catch(e => debug(e, 'mDNS register'));
        this._browse(gen).catch(e => debug(e, 'mDNS browse'));
    }

    async _call(path, iface, method, args, replyType) {
        return Gio.DBus.system.call(
            AVAHI_NAME, path, iface, method,
            args,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable
        );
    }

    /*
     * Publishing
     */
    async _register(gen) {
        if (!this._publication)
            return;

        const {port, txt} = this._publication;

        const reply = await this._call('/', SERVER_IFACE, 'EntryGroupNew', null, '(o)');
        const [group] = reply.deepUnpack();

        if (gen !== this._generation) {
            this._call(group, GROUP_IFACE, 'Free', null, null).catch(() => {});
            return;
        }

        this._groupPath = group;

        // AddService(interface, protocol, flags, name, type, domain, host, port, txt)
        await this._call(group, GROUP_IFACE, 'AddService',
            new GLib.Variant('(iiussssqaay)', [
                IF_UNSPEC, PROTO_UNSPEC, 0,
                this._deviceId, SERVICE_TYPE, '', '', port,
                encodeTxt(txt),
            ]), null);
        await this._call(group, GROUP_IFACE, 'Commit', null, null);

        debug(`mDNS: published ${this._deviceId}.${SERVICE_TYPE} on port ${port}`);
    }

    /*
     * Browsing
     */
    async _browse(gen) {
        // ServiceBrowserNew(interface, protocol, type, domain, flags) -> object path
        const reply = await this._call('/', SERVER_IFACE, 'ServiceBrowserNew',
            new GLib.Variant('(iissu)', [IF_UNSPEC, PROTO_INET, SERVICE_TYPE, '', 0]), '(o)');
        const [browser] = reply.deepUnpack();

        if (gen !== this._generation) {
            this._call(browser, BROWSER_IFACE, 'Free', null, null).catch(() => {});
            return;
        }

        this._browserPath = browser;

        const bus = Gio.DBus.system;
        this._subscriptions.push(bus.signal_subscribe(
            AVAHI_NAME, BROWSER_IFACE, 'ItemNew', browser, null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [ifIndex, protocol, name, type, domain] = params.deepUnpack();
                this._onItemNew(gen, ifIndex, protocol, name, type, domain);
            }
        ));
        this._subscriptions.push(bus.signal_subscribe(
            AVAHI_NAME, BROWSER_IFACE, 'ItemRemove', browser, null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [, , name] = params.deepUnpack();
                this._resolving.delete(name);
            }
        ));
        this._subscriptions.push(bus.signal_subscribe(
            AVAHI_NAME, BROWSER_IFACE, 'Failure', browser, null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                debug(`mDNS browser failure: ${params.deepUnpack()[0]}`);
            }
        ));
    }

    async _onItemNew(gen, ifIndex, protocol, name, type, domain) {
        // Our own announcement, or a non-G-Link name
        if (name === this._deviceId || this._resolving.has(name))
            return;

        this._resolving.add(name);

        try {
            // ResolveService(interface, protocol, name, type, domain, aprotocol, flags)
            const reply = await this._call('/', SERVER_IFACE, 'ResolveService',
                new GLib.Variant('(iisssiu)', [ifIndex, protocol, name, type, domain, PROTO_INET, 0]),
                '(iissssisqaayu)');

            if (gen !== this._generation)
                return;

            const [, , , , , host, , address, port, txt] = reply.deepUnpack();
            debug(`mDNS: resolved ${name} -> ${address}:${port} (${host})`);

            this._onResolved(address, port, decodeTxt(txt.map(b => b.deepUnpack ? b.deepUnpack() : b)), name);
        } catch (e) {
            this._resolving.delete(name);
            debug(e, `mDNS resolve ${name}`);
        }
    }

    _teardown(final) {
        const bus = Gio.DBus.system;

        for (const id of this._subscriptions)
            bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this._resolving.clear();

        // Best effort: ask Avahi to drop our objects. If it is gone these calls just fail quietly.
        const fire = (path, iface, method) => {
            if (!path)
                return;
            // Use a fresh cancellable when stopping, otherwise the cancelled one would swallow the call.
            const cancellable = final ? null : this._cancellable;
            bus.call(AVAHI_NAME, path, iface, method, null, null, Gio.DBusCallFlags.NONE,
                CALL_TIMEOUT_MS, cancellable, (c, res) => {
                    try {
                        c.call_finish(res);
                    } catch (e) { /* daemon already gone */ }
                });
        };

        fire(this._groupPath, GROUP_IFACE, 'Free');
        fire(this._browserPath, BROWSER_IFACE, 'Free');
        this._groupPath = null;
        this._browserPath = null;
    }
}

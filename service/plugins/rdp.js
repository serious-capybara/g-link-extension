// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');


export const Metadata = {
    label: _('Screen Sharing (RDP)'),
    description: _('Let your paired device view this screen (view-only) through GNOME Remote Desktop'),
    id: 'org.gnome.Shell.Extensions.GLink.Plugin.Rdp',
    incomingCapabilities: ['glink.rdp.request'],
    outgoingCapabilities: ['glink.rdp.response'],
    actions: {
        stopSharing: {
            label: _('Stop Screen Sharing'),
            icon_name: 'video-display-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['glink.rdp.response'],
        },
    },
};


/*
 * GNOME Remote Desktop (GRD) integration.
 *
 * Packets
 *   glink.rdp.request   (device -> desktop)  {action: 'start' | 'stop' | 'status'}
 *   glink.rdp.response  (desktop -> device)  {status: 'started' | 'stopped' | 'error',
 *                                            port, username, password, viewOnly, expiresIn, error}
 *   The device connects to the IP it already uses for the G-Link link, so no host is sent.
 *
 * How GRD is driven
 *   - Configuration goes through `grdctl` (GRD's supported CLI) and the GSettings schema
 *     org.gnome.desktop.remote-desktop.rdp, which are stable across GNOME 42+.
 *   - The D-Bus name org.gnome.RemoteDesktop is probed to tell the user whether the GRD user service is
 *     actually running (and to give a precise error when it is not).
 *
 * Safety
 *   - The plugin is DISABLED by default (see the `disabled-plugins` default in the schema): the user must
 *     switch it on for a device in the device's plugin list before anything can be shared.
 *   - Sharing is always view-only, uses fresh random credentials per session, auto-stops after
 *     SESSION_TIMEOUT_SECONDS, when the device disconnects, or when the plugin is unloaded, and the user
 *     gets a notification with a Stop button while it is active.
 *   - If the user already enabled RDP themselves we refuse, instead of overwriting their credentials.
 */

const GRD_SCHEMA = 'org.gnome.desktop.remote-desktop.rdp';
const GRD_BUS_NAME = 'org.gnome.RemoteDesktop';
const RDP_DEFAULT_PORT = 3389;
const RDP_USERNAME = 'glink';
const SESSION_TIMEOUT_SECONDS = 30 * 60;
const NOTIFICATION_ID = 'rdp-sharing';


class RdpError extends Error {}


/**
 * Run a command, resolving with its stdout. Rejects with the command's stderr on failure.
 *
 * @param {string[]} argv - The command and arguments
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<string>} The command's standard output
 */
async function _run(argv, cancellable = null) {
    const proc = new Gio.Subprocess({
        argv,
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(cancellable);

    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);

    if (!proc.get_successful())
        throw new RdpError(`${argv[0]} failed: ${(stderr || stdout || '').trim()}`);

    return stdout;
}


/**
 * @param {number} bytes - Number of random bytes
 * @returns {string} A hex string from the kernel CSPRNG
 */
function _randomHex(bytes) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);

    try {
        const data = stream.read_bytes(bytes, null).toArray();
        return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
    } finally {
        stream.close(null);
    }
}


/**
 * @returns {Gio.Settings|null} GRD's RDP settings, or null if gnome-remote-desktop is not installed
 */
function _grdSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source ? source.lookup(GRD_SCHEMA, true) : null;

    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}


/**
 * @param {Gio.DBusConnection} bus - A bus connection
 * @param {string} name - A well-known bus name
 * @returns {Promise<boolean>} Whether the name currently has an owner
 */
async function _busNameHasOwner(bus, name) {
    try {
        const reply = await bus.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [name]), new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE, 1500, null);

        return reply.deepUnpack()[0];
    } catch (e) {
        return false;
    }
}


/**
 * Screen Sharing Plugin
 */
const RdpPlugin = GObject.registerClass({
    GTypeName: 'GLinkRdpPlugin',
}, class RdpPlugin extends Plugin {

    _init(device) {
        super._init(device, 'rdp');

        this._session = null;       // {password, port, timeoutId, restoreViewOnly}
        this._queue = Promise.resolve();
    }

    handlePacket(packet) {
        if (packet.type !== 'glink.rdp.request')
            return;

        // Serialize start/stop so quick taps on the phone can't interleave grdctl calls
        this._queue = this._queue
            .then(() => this._handleRequest(packet.body.action))
            .catch(e => debug(e, 'RDP request'));
    }

    async _handleRequest(action) {
        try {
            switch (action) {
                case 'start':
                    this._respond(await this._start());
                    break;

                case 'stop':
                    await this._stop();
                    this._respond({status: 'stopped'});
                    break;

                case 'status':
                    this._respond(this._session ? this._startedBody() : {status: 'stopped'});
                    break;

                default:
                    throw new RdpError(`unknown action "${action}"`);
            }
        } catch (e) {
            logError(e, `${this.device.name}: RDP ${action}`);
            await this._stop().catch(() => {});
            this._respond({status: 'error', error: e.message});
        }
    }

    _respond(body) {
        this.device.sendPacket({type: 'glink.rdp.response', body});
    }

    _startedBody() {
        const remaining = Math.max(1, Math.round(this._session.expiresAt - GLib.get_monotonic_time() / 1e6));

        return {
            status: 'started',
            port: this._session.port,
            username: RDP_USERNAME,
            password: this._session.password,
            viewOnly: true,
            expiresIn: remaining,
        };
    }

    /*
     * Session control
     */
    async _start() {
        // Already sharing for this device: hand out the same (still valid) credentials
        if (this._session)
            return this._startedBody();

        const settings = _grdSettings();

        if (settings === null || !GLib.find_program_in_path('grdctl'))
            throw new RdpError('gnome-remote-desktop is not installed (sudo dnf install gnome-remote-desktop)');

        if (settings.get_boolean('enable')) {
            throw new RdpError('Desktop Sharing (RDP) is already enabled on this computer. G-Link will not ' +
                'replace credentials you set yourself; turn it off in Settings > System > Remote Desktop first.');
        }

        const hasGrd = await _busNameHasOwner(Gio.DBus.session, GRD_BUS_NAME);
        debug(`${GRD_BUS_NAME} on session bus: ${hasGrd} (it is started on demand when RDP is enabled)`);

        const restoreViewOnly = !settings.get_boolean('view-only');

        try {
            await this._ensureTls(settings);

            const password = _randomHex(10);

            // Order matters: credentials and view-only must be in place BEFORE the server accepts anyone
            await _run(['grdctl', 'rdp', 'set-credentials', RDP_USERNAME, password], this.cancellable);
            await _run(['grdctl', 'rdp', 'enable-view-only'], this.cancellable);
            await _run(['grdctl', 'rdp', 'enable'], this.cancellable);

            this._session = {
                password,
                port: await this._readPort(),
                restoreViewOnly,
                expiresAt: GLib.get_monotonic_time() / 1e6 + SESSION_TIMEOUT_SECONDS,
                timeoutId: GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SESSION_TIMEOUT_SECONDS, () => {
                    debug('RDP session timed out');
                    this._session.timeoutId = 0;
                    this._queue = this._queue
                        .then(() => this._stop())
                        .then(() => this._respond({status: 'stopped'}))
                        .catch(e => debug(e, 'RDP timeout'));
                    return GLib.SOURCE_REMOVE;
                }),
            };
        } catch (e) {
            // Roll back whatever was configured
            await this._rollback(restoreViewOnly);
            throw e;
        }

        this.device.showNotification({
            id: NOTIFICATION_ID,
            title: _('%s is viewing your screen').format(this.device.name),
            body: _('Screen sharing is view-only and stops automatically after %d minutes.')
                .format(SESSION_TIMEOUT_SECONDS / 60),
            icon: new Gio.ThemedIcon({name: 'video-display-symbolic'}),
            priority: Gio.NotificationPriority.HIGH,
            buttons: [{
                label: _('Stop Sharing'),
                action: 'stopSharing',
                parameter: null,
            }],
        });

        return this._startedBody();
    }

    async _stop() {
        const session = this._session;
        this._session = null;

        if (session === null)
            return;

        if (session.timeoutId)
            GLib.source_remove(session.timeoutId);

        this.device.hideNotification(NOTIFICATION_ID);
        await this._rollback(session.restoreViewOnly);
    }

    async _rollback(restoreViewOnly) {
        // Best effort, every step independent: a failure must not leave the server enabled
        for (const args of [
            ['rdp', 'disable'],
            ['rdp', 'clear-credentials'],
            ...(restoreViewOnly ? [['rdp', 'disable-view-only']] : []),
        ]) {
            try {
                await _run(['grdctl', ...args]);
            } catch (e) {
                debug(e, `grdctl ${args.join(' ')}`);
            }
        }
    }

    /**
     * GRD refuses to serve RDP without a TLS certificate and key. If the user has none configured, create a
     * self-signed pair in ~/.local/share/glink/rdp (the Android client has to accept it either way).
     */
    async _ensureTls(settings) {
        const configured = key => settings.settings_schema.has_key(key) ? settings.get_string(key) : '';
        const cert = configured('tls-cert');
        const key = configured('tls-key');

        if (cert && key && GLib.file_test(cert, GLib.FileTest.EXISTS) &&
            GLib.file_test(key, GLib.FileTest.EXISTS))
            return;

        if (!GLib.find_program_in_path('openssl'))
            throw new RdpError('openssl is required to create a TLS certificate for RDP (sudo dnf install openssl)');

        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'glink', 'rdp']);
        GLib.mkdir_with_parents(dir, 0o700);

        const certPath = GLib.build_filenamev([dir, 'tls.crt']);
        const keyPath = GLib.build_filenamev([dir, 'tls.key']);

        if (!GLib.file_test(certPath, GLib.FileTest.EXISTS) || !GLib.file_test(keyPath, GLib.FileTest.EXISTS)) {
            await _run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650',
                '-subj', '/CN=G-Link', '-keyout', keyPath, '-out', certPath], this.cancellable);
            GLib.chmod(keyPath, 0o600);
        }

        await _run(['grdctl', 'rdp', 'set-tls-cert', certPath], this.cancellable);
        await _run(['grdctl', 'rdp', 'set-tls-key', keyPath], this.cancellable);
    }

    async _readPort() {
        try {
            const status = await _run(['grdctl', 'status'], this.cancellable);
            const match = /Port:\s*(\d+)/.exec(status);

            if (match)
                return parseInt(match[1], 10);
        } catch (e) {
            debug(e, 'grdctl status');
        }

        return RDP_DEFAULT_PORT;
    }

    /**
     * Stop sharing (menu action and notification button).
     */
    stopSharing() {
        this._queue = this._queue
            .then(() => this._stop())
            .then(() => this._respond({status: 'stopped'}))
            .catch(e => debug(e, 'stopSharing'));
    }

    disconnected() {
        super.disconnected();

        // Never leave the screen exposed after the device that asked for it is gone
        this._queue = this._queue.then(() => this._stop()).catch(e => debug(e, 'RDP disconnected'));
    }

    destroy() {
        this._stop().catch(e => debug(e, 'RDP destroy'));
        super.destroy();
    }
});

export default RdpPlugin;

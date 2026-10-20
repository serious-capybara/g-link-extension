// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Device from '../device.js';
import {AvahiDiscovery} from './mdns.js';

// Retain compatibility with GLib < 2.80, which lacks GioUnix
let GioUnix;
try {
    GioUnix = (await import('gi://GioUnix')).default;
} catch {
    GioUnix = {
        InputStream: Gio.UnixInputStream,
        OutputStream: Gio.UnixOutputStream,
    };
}

/**
 * TCP Port Constants
 */
const PROTOCOL_PORT_DEFAULT = 2064;
const PROTOCOL_PORT_MIN = 2064;
const PROTOCOL_PORT_MAX = 2128;
const TRANSFER_MIN = 2096;
const TRANSFER_MAX = 2128;

/**
 * Discovery timing (milliseconds)
 *
 * UDP is lossy, and the first packets after a link comes up can be dropped while the radio wakes. We send a
 * short burst instead of a single packet; receivers de-duplicate. NetworkMonitor emits several signals per
 * real change, so they are coalesced with a short debounce (leading delay, trailing run).
 */
const BROADCAST_BURST_MS = [0, 150, 400];
const NETWORK_DEBOUNCE_MS = 100;

/**
 * Bulk transfer tuning
 *
 * GIO's splice_async() moves data in 8 KiB steps through the GJS main loop, which caps throughput far below
 * what Wi-Fi can do. We pump data ourselves in large chunks and overlap the next read with the current write.
 */
const TRANSFER_CHUNK_SIZE = 256 * 1024;
const PROGRESS_INTERVAL_MS = 500;

/**
 * Pick a socket buffer size for a payload of {@link size} bytes.
 *
 * Returns 0 ("leave it to the kernel's TCP autotuning") for small payloads. Explicitly setting SO_SNDBUF /
 * SO_RCVBUF turns autotuning off, so we only do it where a bigger fixed window clearly pays off: 1 MiB from
 * 8 MiB payloads, 4 MiB from 256 MiB. The kernel may clamp the value (net.core.rmem_max/wmem_max); the
 * granted size is logged so you can see what you actually got.
 *
 * @param {number} size - Payload size in bytes
 * @returns {number} Buffer size in bytes, or 0 to keep the default
 */
export function _socketBufferFor(size) {
    if (size >= 256 * 1024 * 1024)
        return 4 * 1024 * 1024;

    if (size >= 8 * 1024 * 1024)
        return 1024 * 1024;

    return 0;
}

/**
 * Apply {@link _socketBufferFor} to a socket (Linux constants only).
 *
 * @param {Gio.Socket} socket - The socket to tune
 * @param {number} size - Payload size in bytes
 */
function _tuneBulkSocket(socket, size) {
    const bytes = _socketBufferFor(size);

    if (!_LINUX_SOCKETS || bytes === 0 || !socket)
        return;

    try {
        socket.set_option(1, 7, bytes); // SOL_SOCKET, SO_SNDBUF
        socket.set_option(1, 8, bytes); // SOL_SOCKET, SO_RCVBUF
        debug(`socket buffers requested ${bytes}, granted snd=${socket.get_option(1, 7)[1]} rcv=${socket.get_option(1, 8)[1]}`);
    } catch (e) {
        debug(e, 'Tuning socket buffers');
    }
}

/**
 * Copy {@link input} to {@link output} in large chunks, reading the next chunk while the current one is being
 * written, and report progress and speed. Closes both streams, like g_output_stream_splice() with
 * CLOSE_SOURCE | CLOSE_TARGET.
 *
 * @param {Gio.InputStream} input - Source stream
 * @param {Gio.OutputStream} output - Destination stream
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @param {Function} [onProgress] - Called as onProgress(bytesSoFar, megabytesPerSecond) about twice a second
 * @returns {Promise<number>} The number of bytes copied
 */
async function _pump(input, output, cancellable = null, onProgress = null) {
    const started = GLib.get_monotonic_time();
    let windowStart = started;
    let windowBytes = 0;
    let total = 0;
    let pending = null;

    try {
        pending = input.read_bytes_async(TRANSFER_CHUNK_SIZE,
            GLib.PRIORITY_DEFAULT, cancellable);

        for (;;) {
            const bytes = await pending;
            const count = bytes.get_size();

            if (count === 0)
                break;

            // Overlap: start reading the next chunk before writing this one
            pending = input.read_bytes_async(TRANSFER_CHUNK_SIZE,
                GLib.PRIORITY_DEFAULT, cancellable);

            await output.write_all_async(bytes.toArray(),
                GLib.PRIORITY_DEFAULT, cancellable);

            total += count;
            windowBytes += count;

            const now = GLib.get_monotonic_time();
            if (now - windowStart >= PROGRESS_INTERVAL_MS * 1000) {
                const mbps = (windowBytes / 1048576) / ((now - windowStart) / 1e6);
                windowStart = now;
                windowBytes = 0;

                debug(`transfer ${(total / 1048576).toFixed(1)} MiB @ ${mbps.toFixed(1)} MiB/s`);
                if (onProgress)
                    onProgress(total, mbps);
            }
        }

        const seconds = Math.max((GLib.get_monotonic_time() - started) / 1e6, 0.001);
        const average = (total / 1048576) / seconds;
        debug(`transfer finished: ${total} bytes in ${seconds.toFixed(2)} s (${average.toFixed(1)} MiB/s)`);
        if (onProgress)
            onProgress(total, average);

        return total;
    } finally {
        // A read may still be in flight if the write failed: swallow its rejection
        if (pending)
            pending.catch(() => {});

        // Always close, silencing errors (the stream may already be gone)
        input.close_async(GLib.PRIORITY_DEFAULT, null, null);
        output.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }
}


/*
 * One-time check for Linux/FreeBSD socket options
 */
export let _LINUX_SOCKETS = true;

try {
    // This should throw on FreeBSD
    Gio.Socket.new(
        Gio.SocketFamily.IPV4,
        Gio.SocketType.STREAM,
        Gio.SocketProtocol.TCP
    ).get_option(6, 5);
} catch {
    _LINUX_SOCKETS = false;
}


/**
 * Configure a socket connection for the G-Link protocol.
 *
 * @param {Gio.SocketConnection} connection - The connection to configure
 */
export function _configureSocket(connection) {
    try {
        if (_LINUX_SOCKETS) {
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT

        // FreeBSD constants
        // https://github.com/freebsd/freebsd/blob/master/sys/netinet/tcp.h#L159
        } else {
            connection.socket.set_option(6, 256, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 512, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 1024, 3); // TCP_KEEPCNT
        }

        // Small request/response packets must not wait for Nagle + delayed ACK (up to ~40 ms each)
        if (_LINUX_SOCKETS)
            connection.socket.set_option(6, 1, 1); // IPPROTO_TCP, TCP_NODELAY

        // Do this last because an error setting the keepalive options would
        // result in a socket that never times out
        connection.socket.set_keepalive(true);
    } catch (e) {
        debug(e, 'Configuring Socket');
    }
}


/**
 * Lan.ChannelService consists of two parts:
 *
 * The TCP Listener listens on a port and constructs a Channel object from the
 * incoming Gio.TcpConnection.
 *
 * The UDP Listener listens on a port for incoming JSON identity packets which
 * include the TCP port, while the IP address is taken from the UDP packet
 * itself. We respond by opening a TCP connection to that address.
 */
export const ChannelService = GObject.registerClass({
    GTypeName: 'GLinkLanChannelService',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'Certificate',
            'The TLS certificate',
            GObject.ParamFlags.READWRITE,
            Gio.TlsCertificate.$gtype
        ),
        'port': GObject.ParamSpec.uint(
            'port',
            'Port',
            'The port used by the service',
            GObject.ParamFlags.READWRITE,
            0,  GLib.MAXUINT16,
            PROTOCOL_PORT_DEFAULT
        ),
    },
}, class LanChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        // Track hosts we identify to directly, allowing them to ignore the
        // discoverable state of the service.
        this._allowed = new Set();

        //
        this._tcp = null;
        this._tcpPort = PROTOCOL_PORT_DEFAULT;
        this._udp4 = null;
        this._udp6 = null;

        // Monitor network status
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkAvailable = false;
        this._networkChangedId = 0;
        this._networkDebounceId = 0;
        this._burstIds = new Set();

        // mDNS (Avahi). Only active while the manager reports us as discoverable.
        this._mdns = null;
        this._discoverable = false;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        if (this.certificate === certificate)
            return;

        this._certificate = certificate;
        this.notify('certificate');
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    get id() {
        return this.certificate.common_name;
    }

    get port() {
        if (this._port === undefined)
            this._port = PROTOCOL_PORT_DEFAULT;

        return this._port;
    }

    set port(port) {
        if (this.port === port)
            return;

        this._port = port;
        this.notify('port');
    }

    _onNetworkChanged(monitor, network_available) {
        // Do NOT bail out when availability is unchanged: roaming between two Wi-Fi networks never
        // passes through "unavailable" but still needs a fresh announcement.
        this._networkAvailable = network_available;

        if (!network_available)
            return;

        // Coalesce the burst of signals GIO emits for a single real change
        if (this._networkDebounceId !== 0)
            GLib.source_remove(this._networkDebounceId);

        this._networkDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            NETWORK_DEBOUNCE_MS, () => {
                this._networkDebounceId = 0;
                this.broadcastBurst();
                this._mdns?.refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Send the LAN broadcast several times over ~400 ms (see BROADCAST_BURST_MS).
     */
    broadcastBurst() {
        this._clearBurst();

        for (const delay of BROADCAST_BURST_MS) {
            if (delay === 0) {
                this.broadcast();
                continue;
            }

            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._burstIds.delete(id);
                this.broadcast();
                return GLib.SOURCE_REMOVE;
            });
            this._burstIds.add(id);
        }
    }

    _clearBurst() {
        for (const id of this._burstIds)
            GLib.source_remove(id);

        this._burstIds.clear();
    }

    /**
     * Called by the Manager whenever its `discoverable` state changes (and once after start()).
     * mDNS is only published/browsed while we are discoverable, matching what the UDP broadcast does.
     *
     * @param {boolean} discoverable - the Manager's discoverable state
     */
    setDiscoverable(discoverable) {
        this._discoverable = discoverable;

        if (!this.active)
            return;

        if (discoverable)
            this._startMdns();
        else
            this._stopMdns();
    }

    _startMdns() {
        try {
            if (this._mdns === null) {
                this._mdns = new AvahiDiscovery({
                    deviceId: this.id,
                    onResolved: this._onMdnsResolved.bind(this),
                });
            }

            const body = this.identity.body;
            this._mdns.publish(this._tcpPort, {
                id: this.id,
                name: body.deviceName,
                type: body.deviceType,
                protocol: `${body.protocolVersion}`,
            });
            this._mdns.start();
        } catch (e) {
            // mDNS is an optimization; never let it break the UDP/TCP path
            debug(e, 'mDNS start');
        }
    }

    _stopMdns() {
        if (this._mdns === null)
            return;

        this._mdns.stop();
        this._mdns = null;
    }

    /**
     * A G-Link device announced itself via mDNS. Do what Android does after its own mDNS resolve: send our
     * identity packet by UDP straight to it, so it connects to our TCP listener. The UDP port is the
     * protocol's fixed 2064 (the mDNS port is the peer's TCP port, which we do not need here).
     */
    _onMdnsResolved(address, port, txt, name) {
        if (!this._networkAvailable)
            return;

        debug(`mDNS peer ${name} at ${address} (tcp ${port}), sending identity`);
        this.broadcast(`${address}:${PROTOCOL_PORT_DEFAULT}`);
    }

    _initCertificate() {
        const certPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'certificate.pem',
        ]);
        const keyPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'private.pem',
        ]);

        // Ensure a certificate exists with our id as the common name
        this._certificate = Gio.TlsCertificate.new_for_paths(certPath, keyPath,
            null);
    }

    _initTcpListener() {
        try {
            this._tcp = new Gio.SocketService();

            let tcpPort = this.port;
            const tcpPortMax = tcpPort +
                (PROTOCOL_PORT_MAX - PROTOCOL_PORT_MIN);

            while (tcpPort <= tcpPortMax) {
                try {
                    this._tcp.add_inet_port(tcpPort, null);
                    break;
                } catch (e) {
                    if (tcpPort < tcpPortMax) {
                        tcpPort++;
                        continue;
                    }

                    throw e;
                }
            }

            this._tcpPort = tcpPort;
            this._tcp.connect('incoming', this._onIncomingChannel.bind(this));
        } catch (e) {
            this._tcp.stop();
            this._tcp.close();
            this._tcp = null;

            throw e;
        }
    }

    async _onIncomingChannel(listener, connection) {
        try {
            const host = connection.get_remote_address().address.to_string();

            // Create a channel
            const channel = new Channel({
                backend: this,
                certificate: this.certificate,
                host: host,
                port: this.port,
            });

            // Accept the connection
            await channel.accept(connection);
            channel.identity.body.tcpHost = channel.host;
            channel.identity.body.tcpPort = this._tcpPort;
            channel.allowed = this._allowed.has(host);

            this.channel(channel);
        } catch (e) {
            debug(e);
        }
    }

    _initUdpListener() {
        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255', this.port);

        try {
            this._udp6 = Gio.Socket.new(Gio.SocketFamily.IPV6,
                Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            this._udp6.set_broadcast(true);

            // Bind the socket
            const inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV6);
            const sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp6.bind(sockAddr, true);

            // Input stream
            this._udp6_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({
                    fd: this._udp6.fd,
                    close_fd: false,
                }),
            });

            // Watch socket for incoming packets
            this._udp6_source = this._udp6.create_source(GLib.IOCondition.IN, null);
            this._udp6_source.set_callback(this._onIncomingIdentity.bind(this, this._udp6));
            this._udp6_source.attach(null);
        } catch {
            this._udp6 = null;
        }

        // Our IPv6 socket also supports IPv4; we're all done
        if (this._udp6 && this._udp6.speaks_ipv4()) {
            this._udp4 = null;
            return;
        }

        try {
            this._udp4 = Gio.Socket.new(Gio.SocketFamily.IPV4,
                Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            this._udp4.set_broadcast(true);

            // Bind the socket
            const inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV4);
            const sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp4.bind(sockAddr, true);

            // Input stream
            this._udp4_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({
                    fd: this._udp4.fd,
                    close_fd: false,
                }),
            });

            // Watch input socket for incoming packets
            this._udp4_source = this._udp4.create_source(GLib.IOCondition.IN, null);
            this._udp4_source.set_callback(this._onIncomingIdentity.bind(this, this._udp4));
            this._udp4_source.attach(null);
        } catch (e) {
            this._udp4 = null;

            // We failed to get either an IPv4 or IPv6 socket to bind
            if (this._udp6 === null)
                throw e;
        }
    }

    _onIncomingIdentity(socket) {
        let host;

        // Try to peek the remote address
        try {
            host = socket.receive_message([], Gio.SocketMsgFlags.PEEK, null)[1]
                .address.to_string();
        } catch (e) {
            logError(e);
        }

        // Whether or not we peeked the address, we need to read the packet
        try {
            let data;

            if (socket === this._udp6)
                data = this._udp6_stream.read_line_utf8(null)[0];
            else
                data = this._udp4_stream.read_line_utf8(null)[0];

            // Discard the packet if we failed to peek the address
            if (host === undefined)
                return GLib.SOURCE_CONTINUE;

            const packet = new Core.Packet(data);
            packet.body.tcpHost = host;
            this._onIdentity(packet);
        } catch (e) {
            logError(e);
        }

        return GLib.SOURCE_CONTINUE;
    }

    async _onIdentity(packet) {
        try {
            // Bail if the deviceId is missing
            if (!this.identity.body.deviceId)
                throw new Error('missing deviceId');

            // Silently ignore our own broadcasts
            if (packet.body.deviceId === this.identity.body.deviceId)
                return;

            // Reject invalid device IDs
            if (!Device.validateId(packet.body.deviceId))
                throw new Error(`invalid deviceId "${packet.body.deviceId}"`);

            if (!packet.body.deviceName)
                throw new Error('missing deviceName');

            // Sanitize invalid device names
            if (!Device.validateName(packet.body.deviceName)) {
                const sanitized = Device.sanitizeName(packet.body.deviceName);
                debug(`Sanitized invalid device name "${packet.body.deviceName}" to "${sanitized}"`);
                packet.body.deviceName = sanitized;
            }

            debug(packet);

            // Create a new channel
            const channel = new Channel({
                backend: this,
                certificate: this.certificate,
                host: packet.body.tcpHost,
                port: packet.body.tcpPort,
                identity: packet,
            });

            // Check if channel is already open with this address
            if (this.channels.has(channel.address))
                return;

            this._channels.set(channel.address, channel);

            // Open a TCP connection
            const address = Gio.InetSocketAddress.new_from_string(
                packet.body.tcpHost, packet.body.tcpPort);

            const client = new Gio.SocketClient({enable_proxy: false});
            const connection = await client.connect_async(address,
                this.cancellable);

            // Connect the channel and attach it to the device on success
            await channel.open(connection);

            this.channel(channel);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Broadcast an identity packet
     *
     * If {@link address] is not %null it may specify an IPv4 or IPv6 address
     * to send the identity packet directly to, otherwise it will be broadcast
     * to the default address, 255.255.255.255.
     *
     * @param {string} [address] - An optional target IPv4 or IPv6 address
     */
    broadcast(address = null) {
        try {
            if (!this._networkAvailable)
                return;

            // Try to parse strings as <host>:<port>
            if (typeof address === 'string') {
                const [host, portstr] = address.split(':');
                const port = parseInt(portstr) || this.port;
                address = Gio.InetSocketAddress.new_from_string(host, port);
            }

            // If we succeed, remember this host
            if (address instanceof Gio.InetSocketAddress) {
                this._allowed.add(address.address.to_string());

            // Broadcast to the network if no address is specified
            } else {
                debug('Broadcasting to LAN');
                address = this._udp_address;
            }

            // Broadcast on each open socket
            if (this._udp6 !== null)
                this._udp6.send_to(address, this.identity.serialize(), null);

            if (this._udp4 !== null)
                this._udp4.send_to(address, this.identity.serialize(), null);
        } catch (e) {
            debug(e, address);
        }
    }

    buildIdentity() {
        // Chain-up, then add the TCP port
        super.buildIdentity();
        this.identity.body.tcpPort = this._tcpPort;
    }

    start() {
        if (this.active)
            return;

        // Ensure a certificate exists
        if (this.certificate === null)
            this._initCertificate();

        // Start TCP/UDP listeners
        try {
            if (this._tcp === null)
                this._initTcpListener();

            if (this._udp4 === null && this._udp6 === null)
                this._initUdpListener();
        } catch (e) {
            // Known case of another application using the protocol defined port
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ADDRESS_IN_USE)) {
                e.name = _('Port already in use');
                e.url = `${Config.PACKAGE_URL}/wiki/Error#port-already-in-use`;
            }

            throw e;
        }

        // Monitor network changes
        if (this._networkChangedId === 0) {
            this._networkAvailable = this._networkMonitor.network_available;
            this._networkChangedId = this._networkMonitor.connect(
                'network-changed', this._onNetworkChanged.bind(this));
        }

        this._active = true;
        this.notify('active');

        if (this._discoverable)
            this._startMdns();
    }

    stop() {
        if (this._networkDebounceId !== 0) {
            GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = 0;
        }

        this._clearBurst();
        this._stopMdns();

        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
            this._networkAvailable = false;
        }

        if (this._tcp !== null) {
            this._tcp.stop();
            this._tcp.close();
            this._tcp = null;
        }

        if (this._udp6 !== null) {
            this._udp6_source.destroy();
            this._udp6_stream.close(null);
            this._udp6.close();
            this._udp6 = null;
        }

        if (this._udp4 !== null) {
            this._udp4_source.destroy();
            this._udp4_stream.close(null);
            this._udp4.close();
            this._udp4 = null;
        }

        for (const channel of this.channels.values())
            channel.close();

        this._active = false;
        this.notify('active');
    }

    destroy() {
        try {
            this.stop();
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * Lan Channel
 *
 * This class essentially just extends Core.Channel to set TCP socket options
 * and negotiate TLS encrypted connections.
 */
export const Channel = GObject.registerClass({
    GTypeName: 'GLinkLanChannel',
}, class LanChannel extends Core.Channel {

    _init(params) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `lan://${this.host}:${this.port}`;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        this._certificate = certificate;
    }

    get peer_certificate() {
        if (this._connection instanceof Gio.TlsConnection)
            return this._connection.get_peer_certificate();

        return null;
    }

    get host() {
        if (this._host === undefined)
            this._host = null;

        return this._host;
    }

    set host(host) {
        this._host = host;
    }

    get port() {
        if (this._port === undefined) {
            if (this.identity && this.identity.body.tcpPort)
                this._port = this.identity.body.tcpPort;
            else
                return PROTOCOL_PORT_DEFAULT;
        }

        return this._port;
    }

    set port(port) {
        this._port = port;
    }

    /**
     * Authenticate a TLS connection.
     *
     * @param {Gio.TlsConnection} connection - A TLS connection
     * @returns {Promise} A promise for the operation
     */
    async _authenticate(connection) {
        // Standard TLS Handshake
        connection.validation_flags = Gio.TlsCertificateFlags.EXPIRED;
        connection.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;

        await connection.handshake_async(GLib.PRIORITY_DEFAULT,
            this.cancellable);

        // Get a settings object for the device
        let settings;

        if (this.device) {
            settings = this.device.settings;
        } else {
            const id = this.identity.body.deviceId;
            settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GLink.Device',
                    true
                ),
                path: `/org/gnome/shell/extensions/glink/device/${id}/`,
            });
        }

        // If we have a certificate for this deviceId, we can verify it
        const cert_pem = settings.get_string('certificate-pem');

        if (cert_pem !== '') {
            let certificate = null;
            let verified = false;

            try {
                certificate = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
                verified = certificate.is_same(connection.peer_certificate);
            } catch (e) {
                logError(e);
            }

            /* The certificate is incorrect for one of two reasons, but both
             * result in us resetting the certificate and unpairing the device.
             *
             * If the certificate failed to load, it is probably corrupted or
             * otherwise invalid. In this case, if we try to continue we will
             * certainly crash the Android app.
             *
             * If the certificate did not match what we expected the obvious
             * thing to do is to notify the user, however experience tells us
             * this is a result of the user doing something masochistic like
             * nuking the Android app data or copying settings between machines.
             */
            if (verified === false) {
                if (this.device) {
                    this.device.unpair();
                } else {
                    settings.reset('paired');
                    settings.reset('certificate-pem');
                }

                const name = this.identity.body.deviceName;
                throw new Error(`${name}: Authentication Failure`);
            }
        }

        return connection;
    }

    /**
     * Wrap the connection in Gio.TlsClientConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @returns {Gio.TlsClientConnection} The authenticated connection
     */
    _encryptClient(connection) {
        _configureSocket(connection);

        connection = Gio.TlsClientConnection.new(connection,
            connection.socket.remote_address);
        connection.set_certificate(this.certificate);

        return this._authenticate(connection);
    }

    /**
     * Wrap the connection in Gio.TlsServerConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @returns {Gio.TlsServerConnection} The authenticated connection
     */
    _encryptServer(connection) {
        _configureSocket(connection);

        connection = Gio.TlsServerConnection.new(connection, this.certificate);

        // We're the server so we trust-on-first-use and verify after
        const _id = connection.connect('accept-certificate', (connection) => {
            connection.disconnect(_id);
            return true;
        });

        return this._authenticate(connection);
    }

    async _exchangeIdentities() {
        await this.sendPacket(this.backend.identity);
        const identity = await this.readPacket();

        if (this.identity.body.protocolVersion !== identity.body.protocolVersion) {
            this.identity = null;
            throw new Error(`Unexpected protocol version ${identity.protocolVersion}; ` +
                            `handshake started with protocol version ${this.identity.protocolVersion}`);
        }

        if (this.identity.body.deviceId !== identity.body.deviceId) {
            this.identity = null;
            throw new Error(`Unexpected device ID "${identity.body.deviceId}"; ` +
                            `handshake started with device ID "${this.identity.body.deviceId}"`);
        }

        this.identity = identity;
    }

    /**
     * Negotiate an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        debug(`${this.address} (${this.uuid})`);

        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            // In principle this disposable wrapper could buffer more than the
            // identity packet, but in practice the remote device shouldn't send
            // any more data until the TLS connection is negotiated.
            const stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false,
            });

            const data = await stream.read_line_async(GLib.PRIORITY_DEFAULT,
                this.cancellable);
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);

            this.identity = new Core.Packet(data[0]);

            if (!this.identity.body.deviceId)
                throw new Error('missing deviceId');

            // Reject invalid device IDs
            if (!Device.validateId(this.identity.body.deviceId))
                throw new Error(`invalid deviceId "${this.identity.body.deviceId}"`);

            if (!this.identity.body.deviceName)
                throw new Error('missing deviceName');

            // Sanitize invalid device names
            if (!Device.validateName(this.identity.body.deviceName)) {
                const sanitized = Device.sanitizeName(this.identity.body.deviceName);
                debug(`Sanitized invalid device name "${this.identity.body.deviceName}" to "${sanitized}"`);
                this.identity.body.deviceName = sanitized;
            }

            this._connection = await this._encryptClient(connection);

            // Starting with protocol version 8, the devices are expected to
            // exchange identity packets again after TLS negotiation
            if (this.identity.body.protocolVersion >= 8)
                await this._exchangeIdentities();
        } catch (e) {
            this.close();
            throw e;
        }
    }

    /**
     * Negotiate an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     */
    async open(connection) {
        debug(`${this.address} (${this.uuid})`);

        try {
            this._connection = connection;
            this.backend.channels.set(this.address, this);

            await connection.get_output_stream().write_all_async(
                this.backend.identity.serialize(),
                GLib.PRIORITY_DEFAULT,
                this.cancellable);

            this._connection = await this._encryptServer(connection);

            // Starting with protocol version 8, the devices are expected to
            // exchange identity packets again after TLS negotiation
            if (this.identity.body.protocolVersion >= 8)
                await this._exchangeIdentities();
        } catch (e) {
            this.close();
            throw e;
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        if (this.closed)
            return;

        debug(`${this.address} (${this.uuid})`);
        this._closed = true;
        this.notify('closed');

        this.backend.channels.delete(this.address);
        this.cancellable.cancel();

        if (this._connection)
            this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);

        if (this.input_stream)
            this.input_stream.close_async(GLib.PRIORITY_DEFAULT, null, null);

        if (this.output_stream)
            this.output_stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    async download(packet, target, cancellable = null, onProgress = null) {
        const address = Gio.InetSocketAddress.new_from_string(this.host,
            packet.payloadTransferInfo.port);

        const client = new Gio.SocketClient({enable_proxy: false});

        // The receive window is negotiated in the SYN, so the buffer must be set BEFORE connecting
        client.connect('event', (_client, event, _connectable, connection) => {
            if (event === Gio.SocketClientEvent.CONNECTING && connection?.socket)
                _tuneBulkSocket(connection.socket, packet.payloadSize);
        });

        const connection = await client.connect_async(address, cancellable)
            .then(this._encryptClient.bind(this));

        // Start the transfer
        const transferredSize = await _pump(connection.input_stream, target,
            cancellable, onProgress);

        // If we get less than expected, we've certainly got corruption
        if (transferredSize < packet.payloadSize) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: `Incomplete: ${transferredSize}/${packet.payloadSize}`,
            });

        // TODO: sometimes glink-android under-reports a file's size
        //       https://github.com/G-Link/gnome-shell-extension-g-link/issues/1157
        } else if (transferredSize > packet.payloadSize) {
            logError(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: `Extra Data: ${transferredSize - packet.payloadSize}`,
            }));
        }
    }

    async upload(packet, source, size, cancellable = null, onProgress = null) {
        // Start listening on the first available port between 2096-2128
        const listener = new Gio.SocketListener();
        let port = TRANSFER_MIN;

        while (port <= TRANSFER_MAX) {
            try {
                listener.add_inet_port(port, null);
                break;
            } catch (e) {
                if (port < TRANSFER_MAX) {
                    port++;
                    continue;
                } else {
                    throw e;
                }
            }
        }

        // Listen for the incoming connection
        const acceptConnection = listener.accept_async(cancellable)
            .then(result => {
                _tuneBulkSocket(result[0].socket, size);
                return this._encryptServer(result[0]);
            });

        // Create an upload request
        packet.body.payloadHash = this.checksum;
        packet.payloadSize = size;
        packet.payloadTransferInfo = {port: port};
        const requestUpload = this.sendPacket(new Core.Packet(packet),
            cancellable);

        // Request an upload stream, accept the connection and get the output
        const [, connection] = await Promise.all([requestUpload,
            acceptConnection]);

        // Start the transfer
        const transferredSize = await _pump(source, connection.output_stream,
            cancellable, onProgress);

        if (transferredSize !== size) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PARTIAL_INPUT,
                message: 'Transfer incomplete',
            });
        }
    }

    async rejectTransfer(packet) {
        try {
            if (!packet || !packet.hasPayload())
                return;

            if (packet.payloadTransferInfo.port === undefined)
                return;

            const address = Gio.InetSocketAddress.new_from_string(this.host,
                packet.payloadTransferInfo.port);

            const client = new Gio.SocketClient({enable_proxy: false});
            const connection = await client.connect_async(address, null)
                .then(this._encryptClient.bind(this));

            connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }
});

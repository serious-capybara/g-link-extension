// SPDX-FileCopyrightText: G-Link Developers https://github.com/G-Link
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Battery from './battery.js';
import * as Clipboard from './clipboard.js';
import * as ConnectivityReport from './connectivity_report.js';
import * as Contacts from './contacts.js';
import * as FindMyPhone from './findmyphone.js';
import * as Mousepad from './mousepad.js';
import * as Mpris from './mpris.js';
import * as Notification from './notification.js';
import * as Ping from './ping.js';
import * as Presenter from './presenter.js';
import * as Rdp from './rdp.js';
import * as RunCommand from './runcommand.js';
import * as Sftp from './sftp.js';
import * as Share from './share.js';
import * as Sms from './sms.js';
import * as SystemVolume from './systemvolume.js';
import * as Telephony from './telephony.js';

export default {
    battery: Battery,
    clipboard: Clipboard,
    connectivityReport: ConnectivityReport,
    contacts: Contacts,
    findmyphone: FindMyPhone,
    mousepad: Mousepad,
    mpris: Mpris,
    notification: Notification,
    ping: Ping,
    presenter: Presenter,
    rdp: Rdp,
    runcommand: RunCommand,
    sftp: Sftp,
    share: Share,
    sms: Sms,
    systemvolume: SystemVolume,
    telephony: Telephony,
};

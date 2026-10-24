
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
print('Configuring GResource...');
let path = '/home/the-grand-capybara/.local/share/gnome-shell/extensions/g-link@serious-capybara/org.gnome.Shell.Extensions.GLink.gresource';
Gio.Resource.load(path)._register();
try {
    let bytes = Gio.resources_lookup_data('/org/gnome/Shell/Extensions/GLink/org.gnome.Shell.Extensions.GLink.service.in', 0);
    print('Found: success');
} catch (e) {
    print('Failed:', e);
}


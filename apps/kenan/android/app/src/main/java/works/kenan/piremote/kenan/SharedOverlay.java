package works.kenan.piremote.kenan;

import android.accessibilityservice.AccessibilityService;

final class SharedOverlay {
    private static PhoneAccessibilityService phone;
    private static WriteAccessibilityService write;
    private static AccessibilityService owner;
    private static KenanOverlay overlay;

    static KenanOverlay phone(PhoneAccessibilityService service) {
        phone = service;
        ensure(service);
        overlay.refresh();
        return overlay;
    }

    static void write(WriteAccessibilityService service) {
        write = service;
        ensure(service);
        overlay.refresh();
    }

    private static void ensure(AccessibilityService service) {
        if (overlay != null) return;
        owner = service;
        overlay = new KenanOverlay(service);
    }

    static KenanOverlay current() { return overlay; }
    static boolean hasPhone() { return phone != null; }
    static WriteAccessibilityService writer() { return write; }
    static void refresh() { if (overlay != null) overlay.refresh(); }
    static void haptic() { if (overlay != null) overlay.haptic(); }

    static void detach(AccessibilityService service) {
        if (phone == service) phone = null;
        if (write == service) write = null;
        if (owner == service && overlay != null) {
            overlay.close();
            overlay = null;
            owner = null;
            AccessibilityService next = phone != null ? phone : write;
            if (next != null) ensure(next);
        }
        refresh();
    }
}

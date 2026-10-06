package works.kenan.piremote.kenan;

import android.accessibilityservice.AccessibilityService;

final class SharedOverlay {
    private static PhoneAccessibilityService phone;
    private static WriteAccessibilityService write;
    private static AccessibilityService owner;
    private static KenanOverlay overlay;
    private static final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private static boolean refreshPending, focusPending;
    private static final java.util.Map<Integer, Integer> windowTypes = new java.util.HashMap<>();
    static boolean overlayWindow(int id) {
        return java.util.Objects.equals(windowTypes.get(id), android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY);
    }
    static boolean applicationWindow(int id) {
        return java.util.Objects.equals(windowTypes.get(id), android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION);
    }
    static boolean inputMethodWindow(int id) {
        return java.util.Objects.equals(windowTypes.get(id), android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD);
    }
    private static final Runnable reconcile = () -> {
        refreshPending = false;
        boolean focus = focusPending;
        focusPending = false;
        windowTypes.clear();
        if (owner != null) for (android.view.accessibility.AccessibilityWindowInfo window : owner.getWindows())
            windowTypes.put(window.getId(), window.getType());
        if (phone != null) phone.reconcileForeground();
        if (focus && write != null) write.reconcileFocus();
        if (overlay != null) overlay.refreshGeometry();
    };

    static void requestRefresh(boolean focus) {
        focusPending |= focus;
        if (refreshPending) return;
        refreshPending = true;
        main.postDelayed(reconcile, 80);
    }

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
        if (overlay != null && !overlay.closed()) return;
        owner = service;
        overlay = new KenanOverlay(service);
        requestRefresh(false);
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
        if (phone == null && write == null) {
            main.removeCallbacks(reconcile);
            refreshPending = false;
            focusPending = false;
            windowTypes.clear();
        }
        refresh();
    }
}

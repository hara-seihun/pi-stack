package works.kenan.piremote.kenan;

final class SharedOverlay {
    private static PhoneAccessibilityService phone;
    private static KenanOverlay overlay;
    private static KenanOverlay action;
    private static final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private static boolean refreshPending;
    private static int captures;
    private static long actionUntil;
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
    private static final Runnable retireAction = () -> {
        KenanOverlay previous = action;
        action = null;
        actionUntil = 0;
        if (previous != null) previous.close();
    };
    private static final Runnable reconcile = () -> {
        refreshPending = false;
        if (overlay == null || phone == null) return;
        windowTypes.clear();
        for (android.view.accessibility.AccessibilityWindowInfo window : phone.getWindows())
            windowTypes.put(window.getId(), window.getType());
        phone.reconcileForeground();
        overlay.refreshGeometry();
    };

    static void requestRefresh(boolean unused) {
        if (overlay == null || refreshPending) return;
        refreshPending = true;
        main.postDelayed(reconcile, 80);
    }

    static KenanOverlay phone(PhoneAccessibilityService service) {
        if (phone != service) {
            if (phone != null) detach(phone);
            phone = service;
        }
        refresh();
        return overlay;
    }
    static KenanOverlay current() { return overlay; }
    static boolean hasPhone() { return phone != null; }
    static void refresh() {
        if (phone == null || !PermissionSetup.complete(phone) || !KenanOverlay.isVisible(phone)) {
            KenanOverlay previous = overlay;
            overlay = null;
            main.removeCallbacks(reconcile);
            refreshPending = false;
            windowTypes.clear();
            if (previous != null) previous.close();
            return;
        }
        if (overlay == null || overlay.closed()) {
            retireAction.run();
            main.removeCallbacks(retireAction);
            KenanOverlay candidate = new KenanOverlay(phone);
            if (candidate.closed()) { overlay = null; return; }
            overlay = candidate;
            for (int i = 0; i < captures; i++) candidate.suspendCapture();
            requestRefresh(false);
        }
        overlay.refresh();
    }
    static KenanOverlay visualize(PhoneAccessibilityService service, long durationMs) {
        phone(service);
        if (overlay != null) return overlay;
        if (action == null || action.closed()) {
            action = new KenanOverlay(service, true);
            for (int i = 0; i < captures; i++) action.suspendCapture();
        }
        long now = android.os.SystemClock.uptimeMillis();
        actionUntil = Math.max(actionUntil, now + durationMs);
        main.removeCallbacks(retireAction);
        main.postDelayed(retireAction, actionUntil - now);
        return action;
    }
    static void suspendCapture(PhoneAccessibilityService service) {
        if (phone != service) phone(service);
        captures++;
        if (overlay != null) overlay.suspendCapture();
        if (action != null) action.suspendCapture();
    }
    static void restoreCapture(PhoneAccessibilityService service) {
        if (phone != service || captures == 0) return;
        captures--;
        if (overlay != null) overlay.restoreCapture();
        if (action != null) action.restoreCapture();
    }
    static void resetSession() {
        main.removeCallbacks(retireAction);
        retireAction.run();
        if (overlay != null) overlay.resetSession();
    }
    static void haptic() { if (overlay != null) overlay.haptic(); }
    static void detach(PhoneAccessibilityService service) {
        if (phone != service) return;
        phone = null;
        captures = 0;
        refresh();
        main.removeCallbacks(retireAction);
        retireAction.run();
    }
}

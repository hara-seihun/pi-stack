package works.kenan.piremote.kenan;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.BooleanSupplier;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;

public final class PhoneAccessibilityService extends AccessibilityService {
    static volatile PhoneAccessibilityService current;
    private final Map<String, AccessibilityNodeInfo> nodes = new LinkedHashMap<>();
    private long snapshot;
    private int remainingText;
    private boolean truncated;
    private String foregroundPackage, foregroundCandidate;
    private int candidateWindow;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService screenshots = java.util.concurrent.Executors.newSingleThreadExecutor();
    private boolean captureInFlight;
    @Override protected void onServiceConnected() { current = this; ensureOverlay(); PhoneControlService.refresh(); }
    private KenanOverlay ensureOverlay() {
        KenanOverlay overlay = SharedOverlay.phone(this);
        if (overlay != null) overlay.foreground(foregroundPackage);
        return overlay;
    }
    void overlayAck(JSONObject frame) { if (SharedOverlay.current() != null) SharedOverlay.current().ack(frame); }
    void overlayDisconnected() { if (SharedOverlay.current() != null) SharedOverlay.current().disconnected(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (SharedOverlay.current() == null) {
            for (AccessibilityWindowInfo window : getWindows()) {
                if (window.getId() == event.getWindowId()
                    && (window.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
                        || window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD)) return;
            }
        }
        if (SharedOverlay.overlayWindow(event.getWindowId())) return;
        int type = event.getEventType();
        if (type == AccessibilityEvent.TYPE_WINDOWS_CHANGED || type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
            SharedOverlay.requestRefresh(false);
        if (SharedOverlay.inputMethodWindow(event.getWindowId())) return;
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence name = event.getPackageName();
            if (name != null) {
                foregroundCandidate = name.toString(); candidateWindow = event.getWindowId();
                if (SharedOverlay.current() == null) {
                    for (AccessibilityWindowInfo window : getWindows()) {
                        if (window.getId() == candidateWindow && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION)
                            foregroundPackage = foregroundCandidate;
                    }
                    foregroundCandidate = null;
                }
            }
        }
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || event.getEventType() == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) clearNodes();
    }
    void reconcileForeground() {
        if (foregroundCandidate == null) return;
        if (SharedOverlay.applicationWindow(candidateWindow)) {
            foregroundPackage = foregroundCandidate;
            if (SharedOverlay.current() != null) SharedOverlay.current().foreground(foregroundPackage);
        }
        foregroundCandidate = null;
    }
    private boolean isOverlayWindow(int id) {
        for (AccessibilityWindowInfo window : getWindows()) if (window.getId() == id)
            return window.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY;
        return false;
    }
    static void invalidate() {
        PhoneAccessibilityService active = current;
        if (active != null) new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            active.clearNodes(); SharedOverlay.resetSession();
        });
    }
    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); SharedOverlay.requestRefresh(false); }
    @Override public void onInterrupt() { clearNodes(); closeOverlay(); }
    private void closeOverlay() { SharedOverlay.detach(this); }
    @Override public void onDestroy() { if (current == this) current = null; screenshots.shutdown(); clearNodes(); closeOverlay(); PhoneControlService.refresh(); super.onDestroy(); }

    private void clearNodes() { for (AccessibilityNodeInfo node : nodes.values()) node.recycle(); nodes.clear(); }
    void dispatch(String command, JSONObject args, long deadline, BooleanSupplier authorized, Consumer<PhoneResult> done) {
        try {
            var overlayCommand = NativeState.parse(NativeState.OverlayCommand.class, command);
            if (overlayCommand.isPresent()) {
                if (overlayCommand.get() == NativeState.OverlayCommand.SHOW || overlayCommand.get() == NativeState.OverlayCommand.HIDE) {
                    KenanOverlay.setVisible(this, overlayCommand.get() == NativeState.OverlayCommand.SHOW);
                    ensureOverlay();
                    done.accept(PhoneResult.success(new JSONObject().put("visible", KenanOverlay.isVisible(this))));
                    return;
                }
                KenanOverlay chat = ensureOverlay();
                done.accept(chat == null ? PhoneResult.error("disabled", "Kenan overlay chat is disabled")
                    : chat.command(command, args, this::nodeBounds));
                return;
            }
            KenanOverlay visual = SharedOverlay.current();
            var parsed = NativeState.parse(NativeState.AccessibilityCommand.class, command);
            if (parsed.isEmpty()) { done.accept(PhoneResult.error("unsupported", "Unknown accessibility command")); return; }
            if (visual != null && parsed.get() != NativeState.AccessibilityCommand.CAPTURE) visual.closePanel();
            NativeState.Action dispatchAction = switch (parsed.get()) {
                case TREE -> () -> {
                    clearNodes(); snapshot++; remainingText = 500000; truncated = false;
                    AccessibilityNodeInfo root = appRoot();
                    if (root == null) { done.accept(PhoneResult.error("unavailable", "No accessible active window; unlock the phone if needed")); return; }
                    JSONObject tree = walk(root, "" + snapshot + ":0", 0);
                    done.accept(PhoneResult.success(new JSONObject().put("root", tree).put("nodes", nodes.size()).put("truncated", truncated || nodes.size() >= 1500)));
                };
                case TAP, SWIPE -> () -> {
                    float x = (float) args.getDouble(command.equals("ui.tap") ? "x" : "x1");
                    float y = (float) args.getDouble(command.equals("ui.tap") ? "y" : "y1");
                    float x2 = command.equals("ui.tap") ? x : (float) args.getDouble("x2");
                    float y2 = command.equals("ui.tap") ? y : (float) args.getDouble("y2");
                    android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
                    if (!Float.isFinite(x) || !Float.isFinite(y) || !Float.isFinite(x2) || !Float.isFinite(y2)
                        || x < 0 || y < 0 || x2 < 0 || y2 < 0 || x >= metrics.widthPixels || x2 >= metrics.widthPixels
                        || y >= metrics.heightPixels || y2 >= metrics.heightPixels) {
                        done.accept(PhoneResult.error("invalid_args", "Gesture coordinates must be within the display")); return;
                    }
                    long duration = args.optLong("durationMs", command.equals("ui.tap") ? 50 : 300);
                    if (duration < 1 || duration > 10000) { done.accept(PhoneResult.error("invalid_args", "durationMs must be 1..10000")); return; }
                    Path path = new Path(); path.moveTo(x, y); if (!command.equals("ui.tap")) path.lineTo(x2, y2);
                    boolean tap = command.equals("ui.tap");
                    long delay = tap && deadline - System.currentTimeMillis() > duration + 250 ? 200 : 0;
                    KenanOverlay gestureVisual = SharedOverlay.visualize(this, duration + delay + 1000);
                    gestureVisual.refresh(); gestureVisual.moveToTarget(x, y, delay);
                    Runnable inject = () -> {
                        if (current != this || !authorized.getAsBoolean()) { done.accept(PhoneResult.error("disconnected", "Phone session changed before gesture")); return; }
                        if (System.currentTimeMillis() + duration >= deadline) { done.accept(PhoneResult.error("expired", "Gesture cannot finish before the command deadline")); return; }
                        gestureVisual.gesture(x, y, x2, y2, duration, tap);
                        try {
                            boolean accepted = dispatchGesture(new GestureDescription.Builder().addStroke(
                                new GestureDescription.StrokeDescription(path, 0, duration)).build(), new GestureResultCallback() {
                                    @Override public void onCompleted(GestureDescription gesture) { gestureVisual.gestureFinished(); done.accept(PhoneResult.success(new JSONObject())); }
                                    @Override public void onCancelled(GestureDescription gesture) { gestureVisual.gestureFinished(); done.accept(PhoneResult.error("unconfirmed", "Android cancelled the gesture")); }
                                }, null);
                            if (!accepted) { gestureVisual.gestureFinished(); done.accept(PhoneResult.error("unavailable", "Android refused the gesture")); }
                        } catch (RuntimeException failure) { gestureVisual.gestureFinished(); done.accept(PhoneResult.error("unavailable", failure.getMessage())); }
                    };
                    if (delay == 0) inject.run();
                    else main.postDelayed(inject, delay);
                };
                case TEXT, ACTION -> () -> {
                    String id = args.optString("nodeId", "");
                    AccessibilityNodeInfo node = id.isEmpty() ? focused() : nodes.get(id);
                    boolean owned = id.isEmpty();
                    try {
                        if (node == null || !node.refresh()) { done.accept(PhoneResult.error("stale_node", "Read ui.tree again or focus an editable field")); return; }
                        Bundle bundle = new Bundle();
                        int action;
                        if (command.equals("ui.text")) {
                            if (!node.isEditable()) { done.accept(PhoneResult.error("invalid_args", "Node is not editable")); return; }
                            String text = args.getString("text");
                            if (text.length() > 100000) { done.accept(PhoneResult.error("invalid_args", "Text exceeds 100000 characters")); return; }
                            action = AccessibilityNodeInfo.ACTION_SET_TEXT;
                            bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                        } else {
                            action = switch (NativeState.require(NativeState.NodeAction.class, args.getString("action"))) {
                                case CLICK -> AccessibilityNodeInfo.ACTION_CLICK;
                                case LONG_CLICK, LONG_CLICK_ALIAS -> AccessibilityNodeInfo.ACTION_LONG_CLICK;
                                case FOCUS -> AccessibilityNodeInfo.ACTION_FOCUS;
                                case SCROLL_FORWARD, SCROLL_FORWARD_ALIAS -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
                                case SCROLL_BACKWARD, SCROLL_BACKWARD_ALIAS -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
                                case PASTE -> AccessibilityNodeInfo.ACTION_PASTE;
                            };
                        }
                        if (!authorized.getAsBoolean() || System.currentTimeMillis() >= deadline) { done.accept(PhoneResult.error("expired", "Action authorization or deadline expired")); return; }
                        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
                        KenanOverlay actionVisual = SharedOverlay.visualize(this, 1700);
                        actionVisual.refresh(); actionVisual.highlight(bounds);
                        done.accept(node.performAction(action, bundle) ? PhoneResult.success(new JSONObject())
                            : PhoneResult.error("unavailable", "Application refused the accessibility action"));
                    } finally { if (owned && node != null) node.recycle(); }
                };
                case GLOBAL -> () -> {
                    int global = switch (NativeState.require(NativeState.GlobalAction.class, args.getString("action"))) {
                        case BACK -> GLOBAL_ACTION_BACK; case HOME -> GLOBAL_ACTION_HOME; case RECENTS -> GLOBAL_ACTION_RECENTS;
                        case NOTIFICATIONS -> GLOBAL_ACTION_NOTIFICATIONS; case QUICK_SETTINGS -> GLOBAL_ACTION_QUICK_SETTINGS;
                        case LOCK -> GLOBAL_ACTION_LOCK_SCREEN;
                    };
                    done.accept(performGlobalAction(global)
                        ? PhoneResult.success(new JSONObject()) : PhoneResult.error("unavailable", "Android refused the global action"));
                };
                case CAPTURE -> () -> {
                    SharedOverlay.suspendCapture(this);
                    android.view.Choreographer.getInstance().postFrameCallback(first ->
                        android.view.Choreographer.getInstance().postFrameCallback(second -> {
                            if (!authorized.getAsBoolean() || current != this || System.currentTimeMillis() >= deadline) {
                                SharedOverlay.restoreCapture(this);
                                done.accept(PhoneResult.error("expired", "Screenshot authorization or deadline expired")); return;
                            }
                            try { capture(deadline, () -> authorized.getAsBoolean() && current == PhoneAccessibilityService.this,
                                result -> { SharedOverlay.restoreCapture(this); done.accept(result); }); }
                            catch (RuntimeException failure) { SharedOverlay.restoreCapture(this); done.accept(PhoneResult.error("unavailable", failure.getMessage())); }
                        }));
                };
            };
            dispatchAction.run();
        } catch (SecurityException failure) { done.accept(PhoneResult.error("permission_denied", failure.getMessage())); }
        catch (Exception failure) { done.accept(PhoneResult.error("invalid_args", failure.getMessage() == null ? "Invalid accessibility arguments" : failure.getMessage())); }
    }
    private Rect nodeBounds(String id) {
        AccessibilityNodeInfo node = nodes.get(id);
        if (node == null || !node.refresh()) return null;
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds); return bounds;
    }
    private AccessibilityNodeInfo appRoot() {
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
                || window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
            if (window.isActive() || window.isFocused()) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null) return root;
            }
        }
        AccessibilityNodeInfo fallback = null;
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            if (fallback == null || foregroundPackage != null && foregroundPackage.contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) {
                if (fallback != null) fallback.recycle(); fallback = root;
            } else root.recycle();
        }
        if (fallback != null) return fallback;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && isOverlayWindow(root.getWindowId())) { root.recycle(); return null; }
        return root;
    }
    private AccessibilityNodeInfo focused() {
        AccessibilityNodeInfo root = appRoot();
        if (root == null) return null;
        try { return root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT); } finally { root.recycle(); }
    }
    private JSONObject walk(AccessibilityNodeInfo node, String id, int depth) throws Exception {
        nodes.put(id, node);
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        JSONObject result = new JSONObject().put("nodeId", id).put("package", string(node.getPackageName()))
            .put("class", string(node.getClassName())).put("viewId", node.getViewIdResourceName())
            .put("text", node.isPassword() ? "" : string(node.getText())).put("description", node.isPassword() ? "" : string(node.getContentDescription()))
            .put("password", node.isPassword()).put("editable", node.isEditable()).put("clickable", node.isClickable())
            .put("enabled", node.isEnabled()).put("focused", node.isFocused()).put("visible", node.isVisibleToUser())
            .put("bounds", new JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom));
        JSONArray actions = new JSONArray();
        for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) actions.put(action.getId());
        result.put("actions", actions);
        JSONArray children = new JSONArray();
        if (depth >= 32 && node.getChildCount() > 0) truncated = true;
        if (depth < 32 && !node.isPassword()) for (int i = 0; i < node.getChildCount() && nodes.size() < 1500; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) children.put(walk(child, id + "/" + i, depth + 1));
        }
        return result.put("children", children);
    }
    private String string(CharSequence value) {
        if (value == null) return "";
        int length = Math.min(value.length(), Math.min(4096, remainingText));
        if (length < value.length()) truncated = true;
        remainingText -= length;
        return value.subSequence(0, length).toString();
    }
    private void capture(long deadline, BooleanSupplier authorized, Consumer<PhoneResult> done) {
        if (Build.VERSION.SDK_INT < 30) { done.accept(PhoneResult.error("unsupported", "Accessibility screenshots require Android 11 or newer")); return; }
        if (captureInFlight) { done.accept(PhoneResult.error("rate_limited", "A screenshot is already being encoded")); return; }
        captureInFlight = true;
        Consumer<PhoneResult> complete = result -> main.post(() -> {
            captureInFlight = false;
            done.accept(authorized.getAsBoolean() && System.currentTimeMillis() < deadline ? result
                : PhoneResult.error("expired", "Screenshot authorization or deadline expired"));
        });
        try { takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onFailure(int code) {
                complete.accept(PhoneResult.error(code == 3 ? "rate_limited" : code == 6 ? "protected_content" : "unavailable", "Android screenshot error " + code));
            }
            @Override public void onSuccess(ScreenshotResult screenshot) {
                HardwareBuffer buffer = screenshot.getHardwareBuffer();
                try { screenshots.execute(() -> complete.accept(encodeScreenshot(buffer, screenshot.getColorSpace(), deadline, authorized))); }
                catch (java.util.concurrent.RejectedExecutionException stopped) {
                    buffer.close(); complete.accept(PhoneResult.error("disconnected", "Screenshot service stopped"));
                }
            }
        }); } catch (RuntimeException failure) { captureInFlight = false; throw failure; }
    }
    private PhoneResult encodeScreenshot(HardwareBuffer buffer, android.graphics.ColorSpace colorSpace,
        long deadline, BooleanSupplier authorized) {
        try (buffer) {
            if (!authorized.getAsBoolean() || System.currentTimeMillis() >= deadline)
                return PhoneResult.error("expired", "Screenshot authorization or deadline expired");
            if ((long) buffer.getWidth() * buffer.getHeight() > 16_000_000)
                return PhoneResult.error("too_large", "Screenshot exceeds 16 million pixels");
            Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
            if (hardware == null) return PhoneResult.error("unavailable", "Android returned no screenshot bitmap");
            Bitmap bitmap;
            try { bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false); } finally { hardware.recycle(); }
            if (bitmap == null) return PhoneResult.error("unavailable", "Could not copy screenshot");
            try {
                BoundedImageBytes bytes = new BoundedImageBytes(10 * 1024 * 1024);
                boolean compressed = bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                if (bytes.exceeded()) return PhoneResult.error("too_large", "Screenshot exceeds 10 MiB");
                if (!compressed) return PhoneResult.error("unavailable", "PNG encoder refused screenshot");
                if (!authorized.getAsBoolean() || System.currentTimeMillis() >= deadline)
                    return PhoneResult.error("expired", "Screenshot authorization or deadline expired");
                return PhoneResult.success(new JSONObject().put("mime", "image/png")
                    .put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                    .put("width", bitmap.getWidth()).put("height", bitmap.getHeight()));
            } finally { bitmap.recycle(); }
        } catch (Exception failure) {
            return PhoneResult.error("unavailable", "Could not encode screenshot: " + failure.getMessage());
        }
    }
}

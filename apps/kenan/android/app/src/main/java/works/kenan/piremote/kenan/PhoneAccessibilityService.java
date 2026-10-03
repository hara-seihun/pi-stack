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
import java.io.ByteArrayOutputStream;
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
    private String foregroundPackage;
    @Override protected void onServiceConnected() { current = this; ensureOverlay(); PhoneControlService.refresh(); }
    private KenanOverlay ensureOverlay() {
        KenanOverlay overlay = SharedOverlay.phone(this);
        overlay.foreground(foregroundPackage);
        return overlay;
    }
    void overlayAck(JSONObject frame) { if (SharedOverlay.current() != null) SharedOverlay.current().ack(frame); }
    void overlayDisconnected() { if (SharedOverlay.current() != null) SharedOverlay.current().disconnected(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (isOverlayWindow(event.getWindowId())) return;
        ensureOverlay();
        for (AccessibilityWindowInfo window : getWindows()) if (window.getId() == event.getWindowId()
            && window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return;
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence name = event.getPackageName();
            if (name != null && !getPackageName().contentEquals(name)) {
                foregroundPackage = name.toString();
                if (SharedOverlay.current() != null) SharedOverlay.current().foreground(foregroundPackage);
            }
        }
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || event.getEventType() == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) clearNodes();
    }
    private boolean isOverlayWindow(int id) {
        for (AccessibilityWindowInfo window : getWindows()) if (window.getId() == id)
            return window.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY;
        return false;
    }
    static void invalidate() {
        PhoneAccessibilityService active = current;
        if (active != null) new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            active.clearNodes(); if (SharedOverlay.current() != null) SharedOverlay.current().resetSession();
        });
    }
    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); ensureOverlay(); }
    @Override public void onInterrupt() { clearNodes(); closeOverlay(); }
    private void closeOverlay() { SharedOverlay.detach(this); }
    @Override public void onDestroy() { if (current == this) current = null; clearNodes(); closeOverlay(); PhoneControlService.refresh(); super.onDestroy(); }

    private void clearNodes() { for (AccessibilityNodeInfo node : nodes.values()) node.recycle(); nodes.clear(); }
    void dispatch(String command, JSONObject args, long deadline, BooleanSupplier authorized, Consumer<PhoneResult> done) {
        try {
            KenanOverlay visual = ensureOverlay();
            if (command.startsWith("overlay.")) { done.accept(visual.command(command, args, this::nodeBounds)); return; }
            if (command.startsWith("ui.")) visual.closePanel();
            switch (command) {
                case "ui.tree" -> {
                    clearNodes(); snapshot++; remainingText = 500000; truncated = false;
                    AccessibilityNodeInfo root = appRoot();
                    if (root == null) { done.accept(PhoneResult.error("unavailable", "No accessible active window; unlock the phone if needed")); return; }
                    JSONObject tree = walk(root, "" + snapshot + ":0", 0);
                    done.accept(PhoneResult.success(new JSONObject().put("root", tree).put("nodes", nodes.size()).put("truncated", truncated || nodes.size() >= 1500)));
                }
                case "ui.tap", "ui.swipe" -> {
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
                    visual.moveToTarget(x, y, delay);
                    Runnable inject = () -> {
                        if (SharedOverlay.current() != visual || !authorized.getAsBoolean()) { done.accept(PhoneResult.error("disconnected", "Phone session changed before gesture")); return; }
                        if (System.currentTimeMillis() + duration >= deadline) { done.accept(PhoneResult.error("expired", "Gesture cannot finish before the command deadline")); return; }
                        visual.gesture(x, y, x2, y2, duration, tap);
                        try {
                            boolean accepted = dispatchGesture(new GestureDescription.Builder().addStroke(
                                new GestureDescription.StrokeDescription(path, 0, duration)).build(), new GestureResultCallback() {
                                    @Override public void onCompleted(GestureDescription gesture) { visual.gestureFinished(); done.accept(PhoneResult.success(new JSONObject())); }
                                    @Override public void onCancelled(GestureDescription gesture) { visual.gestureFinished(); done.accept(PhoneResult.error("unconfirmed", "Android cancelled the gesture")); }
                                }, null);
                            if (!accepted) { visual.gestureFinished(); done.accept(PhoneResult.error("unavailable", "Android refused the gesture")); }
                        } catch (RuntimeException failure) { visual.gestureFinished(); done.accept(PhoneResult.error("unavailable", failure.getMessage())); }
                    };
                    if (delay == 0) inject.run();
                    else new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(inject, delay);
                }
                case "ui.text", "ui.action" -> {
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
                            action = switch (args.getString("action")) {
                                case "click" -> AccessibilityNodeInfo.ACTION_CLICK;
                                case "longClick", "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK;
                                case "focus" -> AccessibilityNodeInfo.ACTION_FOCUS;
                                case "scrollForward", "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
                                case "scrollBackward", "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
                                case "paste" -> AccessibilityNodeInfo.ACTION_PASTE;
                                default -> 0;
                            };
                            if (action == 0) { done.accept(PhoneResult.error("invalid_args", "Unknown node action")); return; }
                        }
                        Rect bounds = new Rect(); node.getBoundsInScreen(bounds); visual.highlight(bounds);
                        if (!authorized.getAsBoolean() || System.currentTimeMillis() >= deadline) { done.accept(PhoneResult.error("expired", "Action authorization or deadline expired")); return; }
                        done.accept(node.performAction(action, bundle) ? PhoneResult.success(new JSONObject())
                            : PhoneResult.error("unavailable", "Application refused the accessibility action"));
                    } finally { if (owned && node != null) node.recycle(); }
                }
                case "ui.global" -> {
                    int action = switch (args.getString("action")) {
                        case "back" -> GLOBAL_ACTION_BACK; case "home" -> GLOBAL_ACTION_HOME; case "recents" -> GLOBAL_ACTION_RECENTS;
                        case "notifications" -> GLOBAL_ACTION_NOTIFICATIONS; case "quickSettings" -> GLOBAL_ACTION_QUICK_SETTINGS;
                        case "lock" -> GLOBAL_ACTION_LOCK_SCREEN; default -> 0;
                    };
                    done.accept(action == 0 ? PhoneResult.error("invalid_args", "Unknown global action") : performGlobalAction(action)
                        ? PhoneResult.success(new JSONObject()) : PhoneResult.error("unavailable", "Android refused the global action"));
                }
                case "screen.capture" -> {
                    visual.suspendCapture();
                    android.view.Choreographer.getInstance().postFrameCallback(first ->
                        android.view.Choreographer.getInstance().postFrameCallback(second -> {
                            if (!authorized.getAsBoolean() || SharedOverlay.current() != visual || System.currentTimeMillis() >= deadline) {
                                visual.restoreCapture(); done.accept(PhoneResult.error("expired", "Screenshot authorization or deadline expired")); return;
                            }
                            try { capture(result -> { visual.restoreCapture(); done.accept(result); }); }
                            catch (RuntimeException failure) { visual.restoreCapture(); done.accept(PhoneResult.error("unavailable", failure.getMessage())); }
                        }));
                }
                default -> done.accept(PhoneResult.error("unsupported", "Unknown accessibility command"));
            }
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
    private void capture(Consumer<PhoneResult> done) {
        if (Build.VERSION.SDK_INT < 30) { done.accept(PhoneResult.error("unsupported", "Accessibility screenshots require Android 11 or newer")); return; }
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onFailure(int code) {
                done.accept(PhoneResult.error(code == 3 ? "rate_limited" : code == 6 ? "protected_content" : "unavailable", "Android screenshot error " + code));
            }
            @Override public void onSuccess(ScreenshotResult screenshot) {
                try (HardwareBuffer buffer = screenshot.getHardwareBuffer()) {
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, screenshot.getColorSpace());
                    if (hardware == null) { done.accept(PhoneResult.error("unavailable", "Android returned no screenshot bitmap")); return; }
                    Bitmap bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false); hardware.recycle();
                    if (bitmap == null) { done.accept(PhoneResult.error("unavailable", "Could not copy screenshot")); return; }
                    try {
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                        if (bytes.size() > 10 * 1024 * 1024) { done.accept(PhoneResult.error("too_large", "Screenshot exceeds 10 MiB")); return; }
                        done.accept(PhoneResult.success(new JSONObject().put("mime", "image/png")
                            .put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)).put("width", bitmap.getWidth()).put("height", bitmap.getHeight())));
                    } finally { bitmap.recycle(); }
                } catch (Exception failure) { done.accept(PhoneResult.error("unavailable", "Could not encode screenshot: " + failure.getMessage())); }
            }
        });
    }
}

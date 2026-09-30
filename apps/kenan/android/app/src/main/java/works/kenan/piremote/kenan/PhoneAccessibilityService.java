package works.kenan.piremote.kenan;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
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
import org.json.JSONArray;
import org.json.JSONObject;

public final class PhoneAccessibilityService extends AccessibilityService {
    static volatile PhoneAccessibilityService current;
    private final Map<String, AccessibilityNodeInfo> nodes = new LinkedHashMap<>();
    private long snapshot;
    private int remainingText;
    private boolean truncated;
    @Override protected void onServiceConnected() { current = this; PhoneControlService.refresh(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || event.getEventType() == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) clearNodes();
    }
    static void invalidate() {
        PhoneAccessibilityService active = current;
        if (active != null) new android.os.Handler(android.os.Looper.getMainLooper()).post(active::clearNodes);
    }
    @Override public void onInterrupt() { clearNodes(); }
    @Override public void onDestroy() { if (current == this) current = null; clearNodes(); PhoneControlService.refresh(); super.onDestroy(); }

    private void clearNodes() { for (AccessibilityNodeInfo node : nodes.values()) node.recycle(); nodes.clear(); }
    void dispatch(String command, JSONObject args, Consumer<PhoneResult> done) {
        try {
            if ((command.equals("ui.tap") || command.equals("ui.swipe") || command.equals("ui.text") || command.equals("ui.action"))
                && ((android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE)).isDeviceLocked()) {
                done.accept(PhoneResult.error("device_locked", "Authenticated unlock must happen on the phone")); return;
            }
            switch (command) {
                case "ui.tree" -> {
                    clearNodes(); snapshot++; remainingText = 500000; truncated = false;
                    AccessibilityNodeInfo root = getRootInActiveWindow();
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
                    boolean accepted = dispatchGesture(new GestureDescription.Builder().addStroke(
                        new GestureDescription.StrokeDescription(path, 0, duration)).build(), new GestureResultCallback() {
                            @Override public void onCompleted(GestureDescription gesture) { done.accept(PhoneResult.success(new JSONObject())); }
                            @Override public void onCancelled(GestureDescription gesture) { done.accept(PhoneResult.error("unconfirmed", "Android cancelled the gesture")); }
                        }, null);
                    if (!accepted) done.accept(PhoneResult.error("unavailable", "Android refused the gesture"));
                }
                case "ui.text", "ui.action" -> {
                    String id = args.optString("nodeId", "");
                    AccessibilityNodeInfo node = id.isEmpty() && command.equals("ui.text") ? focused() : nodes.get(id);
                    boolean owned = id.isEmpty();
                    try {
                        if (node == null || !node.refresh()) { done.accept(PhoneResult.error("stale_node", "Read ui.tree again or focus an editable field")); return; }
                        if (node.isPassword()) { done.accept(PhoneResult.error("protected_content", "Password fields are not exposed or editable")); return; }
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
                case "screen.capture" -> capture(done);
                default -> done.accept(PhoneResult.error("unsupported", "Unknown accessibility command"));
            }
        } catch (SecurityException failure) { done.accept(PhoneResult.error("permission_denied", failure.getMessage())); }
        catch (Exception failure) { done.accept(PhoneResult.error("invalid_args", failure.getMessage() == null ? "Invalid accessibility arguments" : failure.getMessage())); }
    }
    private AccessibilityNodeInfo focused() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
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

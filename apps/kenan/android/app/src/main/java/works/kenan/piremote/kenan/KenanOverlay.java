package works.kenan.piremote.kenan;

import android.animation.ValueAnimator;
import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.VelocityTracker;
import android.view.WindowInsets;
import android.view.WindowMetrics;
import android.view.accessibility.AccessibilityWindowInfo;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.json.JSONObject;

/** A chat scope or a finite phone-action scope owns every window and callback. */
final class KenanOverlay {
    private static final int CARD = NativeShells.CARD;
    private static final int ACCENT = NativeShells.ACCENT;
    private final AccessibilityService service;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Scene scene;
    private final Dot dot;
    private final WindowManager.LayoutParams dotAt;
    private final ArrayDeque<String> transcript = new ArrayDeque<>();
    private final Map<String, Runnable> pending = new HashMap<>();
    private final Set<View> ownedWindows = new HashSet<>();
    private LinearLayout panel;
    private WindowManager.LayoutParams panelAt;
    private TextView history;
    private EditText input;
    private BackControl backControl;
    private String draft = "";
    private String threadId;
    private String foregroundPackage;
    private NativeState.OverlayAnimation state = NativeState.OverlayAnimation.IDLE;
    private ValueAnimator flight;
    private final boolean actionOnly;
    private final DotTouch touch = new DotTouch();
    private boolean closed, dragging, pressed, overDismiss;
    private OverlayPosition.Bounds lastBounds;
    private int gestures, captures;
    private final Runnable home = this::goHome;
    private final Runnable clearBubble;
    private final Runnable clearHighlight;

    KenanOverlay(AccessibilityService service) { this(service, false); }
    KenanOverlay(AccessibilityService service, boolean actionOnly) {
        this(service, (WindowManager) service.getSystemService(Context.WINDOW_SERVICE), actionOnly);
    }
    KenanOverlay(AccessibilityService service, WindowManager windows) { this(service, windows, false); }
    KenanOverlay(AccessibilityService service, WindowManager windows, boolean actionOnly) {
        this.service = service;
        this.actionOnly = actionOnly;
        this.windows = windows;
        scene = new Scene(); dot = new Dot();
        clearBubble = () -> { scene.words = null; scene.invalidate(); };
        clearHighlight = () -> { scene.highlight = null; scene.invalidate(); };
        WindowManager.LayoutParams canvasAt = placement(WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT, true);
        dotAt = placement(dp(50), dp(50), false);
        dotAt.x = homeX(); dotAt.y = homeY();
        dot.setVisibility(View.INVISIBLE);
        dot.setContentDescription("Kenan. Tap to chat, drag to move.");
        dot.setOnTouchListener(actionOnly ? null : touch);
        if (actionOnly) dotAt.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        if (!add(scene, canvasAt)) return;
        add(dot, dotAt);
    }

    static boolean isVisible(Context context) { return PhoneControlService.settings(context).getBoolean("overlayVisible", true); }
    static void setVisible(Context context, boolean value) {
        PhoneControlService.settings(context).edit().putBoolean("overlayVisible", value).apply();
        SharedOverlay.refresh();
        PhoneControlService.refresh();
    }
    boolean closed() { return closed; }
    private void unavailable(RuntimeException failure) {
        Log.w("KenanOverlay", "Overlay window unavailable", failure);
        close();
    }
    private boolean add(View view, WindowManager.LayoutParams at) {
        try { windows.addView(view, at); ownedWindows.add(view); return true; }
        catch (WindowManager.BadTokenException | WindowManager.InvalidDisplayException | SecurityException failure) {
            unavailable(failure); return false;
        }
    }
    private boolean update(View view, WindowManager.LayoutParams at) {
        if (closed) return false;
        try { windows.updateViewLayout(view, at); return true; }
        catch (IllegalArgumentException | SecurityException failure) { unavailable(failure); return false; }
    }
    private void remove(View view) {
        if (view == null || !ownedWindows.remove(view)) return;
        try { windows.removeViewImmediate(view); }
        catch (IllegalArgumentException | SecurityException failure) { Log.w("KenanOverlay", "Window already detached", failure); }
    }
    void foreground(String name) { if (!closed) foregroundPackage = name; }
    private boolean kenanVisible() { return !closed && !actionOnly && isVisible(service); }
    void refreshGeometry() {
        if (closed) return;
        OverlayPosition.Bounds previous = lastBounds;
        lastBounds = readAvailable();
        if (!dragging && !lastBounds.equals(previous)) {
            if (flight != null) flight.cancel();
            position(homeX(), homeY());
        }
        refresh();
    }
    private String renderedDot;
    void refresh() {
        if (closed) return;
        if (!actionOnly && !isVisible(service)) { close(); return; }
        restoreVisibility();
        String visual = pressed + ":" + state;
        if (!visual.equals(renderedDot)) { renderedDot = visual; dot.invalidate(); }
    }
    void haptic() { if (!closed) NativeHaptics.play(dot, NativeState.Haptic.SELECT.wire()); }

    PhoneResult command(String command, JSONObject args, Function<String, Rect> resolve) throws Exception {
        if (closed) return PhoneResult.error("unavailable", "Kenan overlay is not running");
        var parsed = NativeState.parse(NativeState.OverlayCommand.class, command);
        if (parsed.isEmpty()) return PhoneResult.error("unsupported", "Unknown overlay command");
        return switch (parsed.get()) {
            case SHOW, HIDE -> {
                setVisible(service, command.equals("overlay.show"));
                yield PhoneResult.success(new JSONObject().put("visible", isVisible(service)));
            }
            case CLEAR -> {
                main.removeCallbacks(clearBubble); main.removeCallbacks(clearHighlight); main.removeCallbacks(home);
                scene.words = null; scene.highlight = null; scene.tip = false; goHome(); scene.invalidate();
                yield PhoneResult.success(new JSONObject());
            }
            case STATE -> {
                state(args.getString("state"));
                yield PhoneResult.success(new JSONObject());
            }
            case MOVE, POINT, SAY -> {
                String text = args.has("text") ? args.getString("text") : null;
                if (command.equals("overlay.say") && text == null) yield PhoneResult.error("invalid_args", "text is required");
                if (text != null && text.length() > 2000) yield PhoneResult.error("invalid_args", "Overlay text exceeds 2000 characters");
                long duration = args.optLong("durationMs", text == null ? 0 : Math.min(20000, 3000 + 50L * text.length()));
                if (duration < 0) yield PhoneResult.error("invalid_args", "durationMs must be nonnegative");
                Rect bounds = null;
                float x = 0, y = 0;
                boolean target = args.has("nodeId") || args.has("x") || args.has("y") || args.has("left");
                if (command.equals("overlay.move") && (!args.has("x") || !args.has("y")))
                    yield PhoneResult.error("invalid_args", "move needs x and y");
                if (command.equals("overlay.point") && !target) yield PhoneResult.error("invalid_args", "point needs a target");
                if (args.has("nodeId")) {
                    bounds = resolve.apply(args.getString("nodeId"));
                    if (bounds == null) yield PhoneResult.error("stale_node", "Read ui.tree again before pointing at this node");
                    x = bounds.exactCenterX(); y = bounds.exactCenterY();
                } else if (args.has("left")) {
                    bounds = new Rect(args.getInt("left"), args.getInt("top"), args.getInt("right"), args.getInt("bottom"));
                    if (bounds.isEmpty()) yield PhoneResult.error("invalid_args", "Target bounds must have positive size");
                    x = bounds.exactCenterX(); y = bounds.exactCenterY();
                } else if (target) { x = (float) args.getDouble("x"); y = (float) args.getDouble("y"); }
                if (target && (!Float.isFinite(x) || !Float.isFinite(y) || x < 0 || y < 0 || x >= width() || y >= height()))
                    yield PhoneResult.error("invalid_args", "Target must be within the display");
                if (target) moveToTarget(x, y, 200);
                if (command.equals("overlay.point")) highlight(bounds, x, y, 5000);
                if (text != null) say(text, command.equals("overlay.say") ? duration : Math.min(20000, 3000 + text.length() * 50L));
                yield PhoneResult.success(new JSONObject());
            }
        };
    }

    private WindowManager.LayoutParams placement(int w, int h, boolean untouchable) {
        WindowManager.LayoutParams at = new WindowManager.LayoutParams(w, h,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | (untouchable ? WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE : 0), PixelFormat.TRANSLUCENT);
        at.gravity = Gravity.TOP | Gravity.LEFT;
        if (Build.VERSION.SDK_INT >= 30) at.setFitInsetsTypes(0);
        return at;
    }
    private int dp(float value) { return Math.round(value * service.getResources().getDisplayMetrics().density); }
    private int width() { return service.getResources().getDisplayMetrics().widthPixels; }
    private int height() { return service.getResources().getDisplayMetrics().heightPixels; }
    private OverlayPosition.Bounds available() {
        if (lastBounds == null) lastBounds = readAvailable();
        return lastBounds;
    }
    private OverlayPosition.Bounds readAvailable() {
        int left = dp(6), top = dp(30), right = width() - dp(6), bottom = height() - dp(30);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowMetrics metrics = windows.getCurrentWindowMetrics();
            Rect bounds = metrics.getBounds();
            WindowInsets insets = metrics.getWindowInsets();
            android.graphics.Insets bars = insets.getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars() | WindowInsets.Type.displayCutout());
            left = bounds.left + bars.left + dp(6); top = bounds.top + bars.top + dp(6);
            right = bounds.right - bars.right - dp(6); bottom = bounds.bottom - bars.bottom - dp(6);
            android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
            if (ime.bottom > 0) bottom = Math.min(bottom, bounds.bottom - ime.bottom - dp(8));
        }
        for (AccessibilityWindowInfo window : service.getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
            Rect keyboard = new Rect(); window.getBoundsInScreen(keyboard);
            if (keyboard.top > top + dp(50) && keyboard.bottom >= bottom - dp(80))
                bottom = Math.min(bottom, keyboard.top - dp(8));
        }
        return new OverlayPosition.Bounds(left, top, Math.max(left + dp(50), right), Math.max(top + dp(50), bottom));
    }
    private int homeX() {
        OverlayPosition.Bounds bounds = available();
        return PhoneControlService.settings(service).getBoolean("overlayRight", true) ? bounds.right() - dp(50) : bounds.left();
    }
    private int homeY() { return OverlayPosition.restoreY(PhoneControlService.settings(service).getFloat("overlayY", .42f), available(), dp(50)); }
    private void goHome() { if (!closed && !actionOnly && !dragging) { scene.tip = false; fly(homeX(), homeY(), 320); } }
    private void activity() {
        if (closed) return;
        main.removeCallbacks(home);
        if (!actionOnly && state == NativeState.OverlayAnimation.IDLE && gestures == 0) main.postDelayed(home, 6000);
    }
    private void position(int x, int y) {
        if (closed) return;
        OverlayPosition.Point at = OverlayPosition.clamp(x, y, available(), dp(50));
        if (dotAt.x == at.x() && dotAt.y == at.y()) return;
        dotAt.x = at.x(); dotAt.y = at.y();
        update(dot, dotAt); scene.invalidate();
    }
    private void fly(int x, int y, long duration) {
        if (closed) return;
        if (flight != null) flight.cancel();
        if (duration == 0) { position(x, y); return; }
        int fromX = dotAt.x, fromY = dotAt.y;
        if (fromX == x && fromY == y) { flight = null; return; }
        flight = ValueAnimator.ofFloat(0, 1); flight.setDuration(duration);
        flight.setInterpolator(new android.view.animation.DecelerateInterpolator());
        flight.addUpdateListener(frame -> {
            float t = (float) frame.getAnimatedValue();
            position(fromX + Math.round((x - fromX) * t), fromY + Math.round((y - fromY) * t));
        });
        flight.start();
    }
    void moveToTarget(float x, float y, long duration) {
        if (closed) return;
        scene.tipX = x; scene.tipY = y; scene.tip = true;
        int offset = x > width() / 2f ? -dp(58) : dp(10);
        fly(Math.round(x) + offset, Math.round(y) - dp(58), duration);
        activity();
    }
    void highlight(Rect bounds, float x, float y, long duration) {
        if (closed) return;
        main.removeCallbacks(clearHighlight);
        scene.highlight = bounds == null ? new RectF(x - dp(18), y - dp(18), x + dp(18), y + dp(18)) : new RectF(bounds);
        scene.pointHighlight = bounds == null; scene.invalidate();
        main.postDelayed(clearHighlight, duration); activity();
    }
    void highlight(Rect bounds) { highlight(bounds, bounds.exactCenterX(), bounds.exactCenterY(), 1500); moveToTarget(bounds.exactCenterX(), bounds.exactCenterY(), 0); }
    void gesture(float x, float y, float x2, float y2, long duration, boolean tap) {
        if (closed) return;
        closePanel(); gestures++; touchability(); dot.invalidate(); main.removeCallbacks(home);
        scene.gestureX = x; scene.gestureY = y; scene.endX = x2; scene.endY = y2;
        scene.gestureStart = SystemClock.uptimeMillis(); scene.gestureDuration = duration;
        scene.tap = tap; scene.gestureUntil = scene.gestureStart + duration + 600; scene.invalidate();
    }
    void gestureFinished() { if (closed) return; if (gestures > 0) gestures--; touchability(); dot.invalidate(); activity(); }
    private void touchability() {
        if (closed) return;
        if (actionOnly || gestures > 0) dotAt.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else dotAt.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        if (!update(dot, dotAt)) return;
        if (panel != null) {
            if (gestures > 0) panelAt.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            else panelAt.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            update(panel, panelAt);
        }
    }
    void state(String next) {
        NativeState.OverlayAnimation parsed = NativeState.require(NativeState.OverlayAnimation.class, next);
        if (closed || state == parsed) return;
        state = parsed;
        dot.invalidate();
        Runnable reconcile = switch (state) {
            case IDLE -> this::activity;
            case THINKING, WORKING -> () -> main.removeCallbacks(home);
        };
        reconcile.run();
    }
    void say(String text, long duration) {
        if (closed || actionOnly) return;
        main.removeCallbacks(clearBubble);
        if (text.isEmpty()) { scene.words = null; scene.invalidate(); return; }
        scene.words = StaticLayout.Builder.obtain(text, 0, text.length(), scene.textPaint, Math.max(dp(100), Math.round(width() * .75f) - dp(28)))
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).setMaxLines(6)
            .setEllipsize(TextUtils.TruncateAt.END).setLineSpacing(dp(3), 1).build();
        addLine("Kenan", text); scene.invalidate(); activity();
        if (duration > 0) main.postDelayed(clearBubble, duration);
    }
    private void error(String message) { state("idle"); say(message, 5000); }
    private void addLine(String who, String text) {
        transcript.addLast(who + ": " + text);
        while (transcript.size() > 20) transcript.removeFirst();
        if (history != null) {
            history.setText(TextUtils.join("\n\n", transcript));
            ((View) history.getParent()).setVisibility(View.VISIBLE);
        }
    }
    void ack(JSONObject frame) {
        Runnable timeout = pending.remove(frame.optString("id"));
        if (timeout == null || closed) return;
        main.removeCallbacks(timeout);
        if (frame.optBoolean("ok")) threadId = frame.optString("threadId", null);
        else {
            JSONObject failure = frame.optJSONObject("error");
            error(failure == null ? "Could not send your message" : failure.optString("message", "Could not send your message"));
        }
    }
    void disconnected() {
        if (closed) return;
        boolean uncertain = !pending.isEmpty();
        for (Runnable timeout : pending.values()) main.removeCallbacks(timeout);
        pending.clear();
        state("idle");
        if (uncertain) say("Connection lost. Your message may not have reached Kenan.", 5000);
    }
    void resetSession() {
        if (closed || actionOnly) return;
        closePanel(); main.removeCallbacksAndMessages(null); pending.clear(); transcript.clear(); threadId = null; draft = "";
        scene.words = null; scene.highlight = null; scene.tip = false; scene.gestureUntil = 0; state("idle"); goHome();
    }
    private void send() {
        if (closed || actionOnly || input == null) return;
        String text = input.getText().toString().trim();
        if (text.isEmpty()) return;
        String id = UUID.randomUUID().toString();
        try {
            String label = null;
            if (foregroundPackage != null) {
                try { label = service.getPackageManager().getApplicationLabel(service.getPackageManager().getApplicationInfo(foregroundPackage, 0)).toString(); }
                catch (android.content.pm.PackageManager.NameNotFoundException missing) { label = null; }
            }
            JSONObject frame = new JSONObject().put("type", "overlay.message").put("id", id).put("text", text)
                .put("context", new JSONObject().put("package", foregroundPackage == null ? JSONObject.NULL : foregroundPackage)
                    .put("label", label == null ? JSONObject.NULL : label));
            if (!PhoneControlService.sendOverlay(frame)) { closePanel(); error("Phone connection is down. Open Kenan to reconnect."); return; }
            addLine("You", text); input.setText(""); closePanel(); state("thinking");
            Runnable timeout = () -> { pending.remove(id); error("No receipt yet. Your message may have reached Kenan; it was not sent again."); };
            pending.put(id, timeout); main.postDelayed(timeout, 15000);
        } catch (org.json.JSONException defect) { error("Could not prepare your message"); }
    }
    private static final class BackControl {
        private final android.window.OnBackInvokedDispatcher dispatcher;
        private final android.window.OnBackInvokedCallback callback;
        BackControl(View view, Runnable action) {
            dispatcher = view.findOnBackInvokedDispatcher(); callback = action::run;
            if (dispatcher != null) dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback);
        }
        void close() { if (dispatcher != null) dispatcher.unregisterOnBackInvokedCallback(callback); }
    }
    private final class Panel extends LinearLayout {
        Panel() { super(service); }
        @Override public boolean dispatchKeyEventPreIme(KeyEvent event) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) { if (event.getAction() == KeyEvent.ACTION_UP) closePanel(); return true; }
            return super.dispatchKeyEventPreIme(event);
        }
        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) { if (event.getAction() == KeyEvent.ACTION_UP) closePanel(); return true; }
            return super.dispatchKeyEvent(event);
        }
    }
    private void openPanel() {
        if (closed || !kenanVisible() || gestures > 0 || captures > 0) return;
        if (panel != null) { closePanel(); return; }
        panel = new Panel();
        NativeShells.Conversation conversation = NativeShells.conversation(service, panel, TextUtils.join("\n\n", transcript), draft, () -> {
            Intent intent = new Intent(service, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            RemoteSession.Identity identity = NotificationIdentity.get(service).current();
            if (threadId != null && identity != null) intent.putExtra("sessionId", threadId).putExtra("user", identity.user)
                .putExtra("environment", PhoneControlService.settings(service).getString("environment", ""));
            closePanel(); service.startActivity(intent);
        }, this::closePanel, this::send);
        history = conversation.history();
        input = conversation.input();
        ScrollView scroll = conversation.scroll();
        panelAt = new WindowManager.LayoutParams(-1, -2, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        panelAt.gravity = Gravity.BOTTOM;
        panelAt.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE;
        if (!add(panel, panelAt)) return;
        input.requestFocus();
        EditText openedInput = input;
        LinearLayout openedPanel = panel;
        main.post(() -> {
            if (closed || input != openedInput || panel != openedPanel) return;
            if (Build.VERSION.SDK_INT >= 33) backControl = new BackControl(panel, this::closePanel);
            ((InputMethodManager) service.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
        });
        main.post(() -> { if (!closed && panel == openedPanel) scroll.fullScroll(View.FOCUS_DOWN); });
    }
    void closePanel() {
        if (panel == null) return;
        draft = input.getText().toString();
        if (backControl != null) { backControl.close(); backControl = null; }
        ((InputMethodManager) service.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(panel.getWindowToken(), 0);
        remove(panel); panel = null; panelAt = null; input = null; history = null;
    }
    void suspendCapture() { if (!closed) { captures++; restoreVisibility(); } }
    void restoreCapture() { if (!closed) { if (captures > 0) captures--; restoreVisibility(); } }
    private void restoreVisibility() {
        if (closed) return;
        scene.setVisibility(captures > 0 ? View.INVISIBLE : View.VISIBLE);
        dot.setVisibility(captures == 0 ? View.VISIBLE : View.INVISIBLE);
        if (panel != null) panel.setVisibility(captures > 0 ? View.INVISIBLE : View.VISIBLE);
    }
    void close() {
        if (closed) return;
        closePanel(); closed = true; main.removeCallbacksAndMessages(null); pending.clear();
        touch.cancel(); dot.setOnTouchListener(null); dot.removeCallbacks(dot.frame);
        if (flight != null) { flight.cancel(); flight.removeAllUpdateListeners(); flight = null; }
        remove(dot); remove(scene);
        transcript.clear(); draft = ""; threadId = null; foregroundPackage = null;
        scene.words = null; scene.highlight = null; scene.tip = false; scene.gestureUntil = 0;
    }
    private float dismissX() { return available().left() + available().width() / 2f; }
    private float dismissY() { return available().bottom() - dp(48); }
    private void snap(float velocity) {
        OverlayPosition.Bounds bounds = available();
        OverlayPosition.Point edge = OverlayPosition.snap(dotAt.x, dotAt.y, bounds, dp(50), velocity);
        PhoneControlService.settings(service).edit().putBoolean("overlayRight", edge.x() != bounds.left())
            .putFloat("overlayY", OverlayPosition.saveY(edge.y(), bounds, dp(50))).apply();
        scene.tip = false; fly(edge.x(), edge.y(), 180);
    }
    private final class DotTouch implements View.OnTouchListener {
        private float downX, downY;
        private int startX, startY;
        private VelocityTracker velocity;
        private void cancel() { if (velocity != null) { velocity.recycle(); velocity = null; } }
        private void track(MotionEvent event) {
            if (velocity == null) return;
            MotionEvent raw = MotionEvent.obtain(event); raw.setLocation(event.getRawX(), event.getRawY());
            velocity.addMovement(raw); raw.recycle();
        }
        @Override public boolean onTouch(View view, MotionEvent event) {
            if (closed || actionOnly) return false;
            return switch (NativeState.Touch.require(event.getActionMasked())) {
                case DOWN -> {
                    if (flight != null) flight.cancel(); main.removeCallbacks(home);
                    downX = event.getRawX(); downY = event.getRawY(); startX = dotAt.x; startY = dotAt.y;
                    dragging = false; pressed = true; refresh();
                    velocity = VelocityTracker.obtain(); track(event);
                    yield true;
                }
                case MOVE -> {
                    track(event);
                    if (OverlayPosition.dragged(downX, downY, event.getRawX(), event.getRawY(), ViewConfiguration.get(service).getScaledTouchSlop())) dragging = true;
                    if (dragging) {
                        int x = startX + Math.round(event.getRawX() - downX), y = startY + Math.round(event.getRawY() - downY);
                        OverlayPosition.Point wanted = OverlayPosition.clamp(x, y, available(), dp(50));
                        boolean near = Math.hypot(wanted.x() + dp(25) - dismissX(), wanted.y() + dp(25) - dismissY()) < dp(54);
                        if (near && !overDismiss) haptic();
                        overDismiss = near;
                        if (near) {
                            OverlayPosition.Point at = OverlayPosition.magnet(wanted,
                                new OverlayPosition.Point(Math.round(dismissX()) - dp(26), Math.round(dismissY()) - dp(26)), dp(50), dp(52));
                            position(at.x(), at.y());
                        } else position(wanted.x(), wanted.y());
                        scene.invalidate();
                    }
                    yield true;
                }
                case UP, CANCEL -> {
                    float vx = 0;
                    if (velocity != null) { track(event); velocity.computeCurrentVelocity(1000); vx = velocity.getXVelocity(); velocity.recycle(); velocity = null; }
                    boolean moved = dragging;
                    boolean dropped = moved && event.getActionMasked() == MotionEvent.ACTION_UP && overDismiss;
                    dragging = false; pressed = false; overDismiss = false; scene.invalidate();
                    if (dropped) setVisible(service, false);
                    else if (moved) snap(vx);
                    else if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                        dot.performClick();
                        openPanel();
                    }
                    refresh();
                    yield true;
                }
                case POINTER_DOWN, POINTER_UP -> true; // The shared dot tracks the first pointer only.
                case OUTSIDE, HOVER_MOVE, HOVER_ENTER, HOVER_EXIT, SCROLL, BUTTON_PRESS, BUTTON_RELEASE -> false;
            };
        }
    }
    private final class Dot extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Runnable frame = this::invalidate;
        Dot() { super(service); }
        private void resumeAnimation() {
            if (frame == null) return;
            removeCallbacks(frame);
            if (!closed && isShown() && getWindowVisibility() == View.VISIBLE) invalidate();
        }
        @Override protected void onVisibilityChanged(View changed, int visibility) { super.onVisibilityChanged(changed, visibility); resumeAnimation(); }
        @Override protected void onWindowVisibilityChanged(int visibility) { super.onWindowVisibilityChanged(visibility); resumeAnimation(); }
        @Override protected void onDetachedFromWindow() { removeCallbacks(frame); super.onDetachedFromWindow(); }
        @Override protected void onDraw(Canvas canvas) {
            if (closed || !isShown() || getWindowVisibility() != View.VISIBLE) return;
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            long now = SystemClock.uptimeMillis();
            NativeState.OverlayAnimation animation = gestures > 0 ? NativeState.OverlayAnimation.WORKING : state;
            double period = switch (animation) { case WORKING -> 170.0; case IDLE, THINKING -> 850.0; };
            float pulse = animation == NativeState.OverlayAnimation.IDLE ? .5f : (float) (.5 + .5 * Math.sin(now / period));
            paint.setStyle(Paint.Style.FILL); paint.setColor(ACCENT); paint.setAlpha(25 + Math.round(pulse * 35));
            canvas.drawCircle(cx, cy, dp(22), paint);
            paint.setColor(CARD); paint.setAlpha(255); canvas.drawCircle(cx, cy, dp(17), paint);
            paint.setColor(ACCENT); canvas.drawCircle(cx, cy, dp(7) + dp(1) * pulse, paint);
            if (animation == NativeState.OverlayAnimation.THINKING) {
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2)); paint.setStrokeCap(Paint.Cap.ROUND);
                canvas.drawArc(cx - dp(13), cy - dp(13), cx + dp(13), cy + dp(13), (now % 1400) * 360f / 1400, 100, false, paint);
            }
            removeCallbacks(frame);
            if (animation != NativeState.OverlayAnimation.IDLE) postDelayed(frame, 40);
        }
    }
    private final class Scene extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint textPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final RectF bubble = new RectF();
        private final Path tail = new Path();
        private StaticLayout words;
        private RectF highlight;
        private boolean pointHighlight, tip, tap;
        private float tipX, tipY, gestureX, gestureY, endX, endY;
        private long gestureStart, gestureDuration, gestureUntil;
        Scene() { super(service); textPaint.setColor(Color.WHITE); textPaint.setTextSize(dp(15)); setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS); }
        @Override protected void onDraw(Canvas canvas) {
            if (closed || !isShown() || getWindowVisibility() != View.VISIBLE) return;
            long now = SystemClock.uptimeMillis();
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2)); paint.setColor(ACCENT); paint.setAlpha(255);
            if (highlight != null) {
                paint.setAlpha(120 + Math.round(100 * (float) (.5 + .5 * Math.sin(now / 180.0))));
                if (pointHighlight) canvas.drawCircle(highlight.centerX(), highlight.centerY(), dp(18) + dp(3) * (float) Math.sin(now / 180.0), paint);
                else canvas.drawRoundRect(highlight, dp(10), dp(10), paint);
            }
            if (now < gestureUntil) {
                float progress = Math.min(1, (now - gestureStart) / (float) gestureDuration);
                paint.setAlpha(Math.round(220 * Math.min(1, (gestureUntil - now) / 600f)));
                if (tap) canvas.drawCircle(gestureX, gestureY, dp(8) + dp(32) * Math.min(1, (now - gestureStart) / 600f), paint);
                else {
                    paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeWidth(dp(5));
                    canvas.drawLine(gestureX, gestureY, gestureX + (endX - gestureX) * progress, gestureY + (endY - gestureY) * progress, paint);
                    canvas.drawCircle(gestureX + (endX - gestureX) * progress, gestureY + (endY - gestureY) * progress, dp(7), paint);
                }
            }
            paint.setAlpha(255);
            if (tip) {
                paint.setStrokeWidth(dp(2)); paint.setColor(ACCENT); paint.setAlpha(170);
                canvas.drawLine(dotAt.x + dp(24), dotAt.y + dp(24), tipX, tipY, paint);
                canvas.drawCircle(tipX, tipY, dp(3), paint); paint.setAlpha(255);
            }
            if (kenanVisible() && words != null) {
                float w = words.getWidth() + dp(28), h = words.getHeight() + dp(24);
                float cx = dotAt.x + dp(24), cy = dotAt.y + dp(24);
                float left = Math.max(dp(8), Math.min(width() - w - dp(8), cx < width() / 2f ? cx + dp(28) : cx - w - dp(28)));
                float top = Math.max(dp(36), Math.min(height() - h - dp(36), cy - h / 2));
                bubble.set(left, top, left + w, top + h);
                paint.setStyle(Paint.Style.FILL); paint.setColor(CARD);
                tail.reset(); tail.moveTo(cx, cy); tail.lineTo(bubble.centerX(), Math.max(top + dp(12), Math.min(top + h - dp(12), cy - dp(8))));
                tail.lineTo(bubble.centerX(), Math.max(top + dp(12), Math.min(top + h - dp(12), cy + dp(8)))); tail.close();
                canvas.drawPath(tail, paint); canvas.drawRoundRect(bubble, dp(16), dp(16), paint);
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1)); paint.setColor(0xff46516f);
                canvas.drawRoundRect(bubble, dp(16), dp(16), paint);
                canvas.save(); canvas.translate(left + dp(14), top + dp(12)); words.draw(canvas); canvas.restore();
            }
            if (dragging) {
                    float cx = dismissX(), cy = dismissY();
                    paint.setStyle(Paint.Style.FILL); paint.setColor(overDismiss ? 0xffa44155 : CARD);
                    paint.setAlpha(255);
                    canvas.drawCircle(cx, cy, dp(26), paint);
                    paint.setColor(Color.WHITE); paint.setAlpha(255);
                    paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
                    canvas.drawLine(cx - dp(6), cy - dp(11), cx + dp(6), cy + dp(1), paint);
                    canvas.drawLine(cx - dp(6), cy + dp(1), cx + dp(6), cy - dp(11), paint);
                    paint.setStyle(Paint.Style.FILL); paint.setTextSize(dp(11)); paint.setTextAlign(Paint.Align.CENTER);
                    canvas.drawText("Hide", cx, cy + dp(17), paint);
                paint.setAlpha(255);
            }
            if (highlight != null || now < gestureUntil) postInvalidateOnAnimation();
        }
    }
}

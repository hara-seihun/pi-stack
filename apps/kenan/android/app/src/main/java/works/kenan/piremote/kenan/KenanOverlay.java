package works.kenan.piremote.kenan;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputFilter;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.json.JSONObject;

/** All windows and timers are owned by one accessibility-service lifetime. */
final class KenanOverlay {
    private static final int CARD = 0xff242b40;
    private static final int ACCENT = 0xffb8c8ff;
    private final PhoneAccessibilityService service;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Scene scene;
    private final Dot dot;
    private final WindowManager.LayoutParams dotAt;
    private final ArrayDeque<String> transcript = new ArrayDeque<>();
    private final Map<String, Runnable> pending = new HashMap<>();
    private LinearLayout panel;
    private WindowManager.LayoutParams panelAt;
    private TextView history;
    private EditText input;
    private BackControl backControl;
    private String draft = "";
    private String threadId;
    private String foregroundPackage;
    private String state = "idle";
    private ValueAnimator flight;
    private boolean visible, closed, dragging, overDismiss;
    private int gestures, captures;
    private final Runnable home = this::goHome;
    private final Runnable clearBubble;
    private final Runnable clearHighlight;

    KenanOverlay(PhoneAccessibilityService service) {
        this.service = service;
        windows = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
        scene = new Scene(); dot = new Dot();
        clearBubble = () -> { scene.words = null; scene.invalidate(); };
        clearHighlight = () -> { scene.highlight = null; scene.invalidate(); };
        WindowManager.LayoutParams canvasAt = placement(WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT, true);
        dotAt = placement(dp(48), dp(48), false);
        dotAt.x = homeX(); dotAt.y = homeY();
        visible = isVisible(service);
        dot.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        dot.setContentDescription("Kenan. Tap to chat, drag to move.");
        dot.setOnTouchListener(new DotTouch());
        windows.addView(scene, canvasAt);
        try { windows.addView(dot, dotAt); }
        catch (RuntimeException failure) { windows.removeView(scene); throw failure; }
    }

    static boolean isVisible(Context context) { return PhoneControlService.settings(context).getBoolean("overlayVisible", true); }
    static void setVisible(Context context, boolean value) {
        PhoneControlService.settings(context).edit().putBoolean("overlayVisible", value).apply();
        PhoneAccessibilityService active = PhoneAccessibilityService.current;
        if (active != null) active.overlayVisibility(value);
        PhoneControlService.refresh();
    }
    void visibility(boolean value) {
        if (closed) return;
        visible = value;
        if (!value) { closePanel(); scene.words = null; }
        restoreVisibility();
    }
    void foreground(String name) { foregroundPackage = name; }

    PhoneResult command(String command, JSONObject args, Function<String, Rect> resolve) throws Exception {
        if (closed) return PhoneResult.error("unavailable", "Kenan overlay is not running");
        switch (command) {
            case "overlay.show", "overlay.hide" -> {
                setVisible(service, command.equals("overlay.show"));
                return PhoneResult.success(new JSONObject().put("visible", visible));
            }
            case "overlay.clear" -> {
                main.removeCallbacks(clearBubble); main.removeCallbacks(clearHighlight); main.removeCallbacks(home);
                scene.words = null; scene.highlight = null; scene.tip = false; goHome(); scene.invalidate();
            }
            case "overlay.state" -> {
                String next = args.getString("state");
                if (!next.equals("idle") && !next.equals("thinking") && !next.equals("working"))
                    return PhoneResult.error("invalid_args", "state must be idle, thinking or working");
                state(next);
            }
            case "overlay.move", "overlay.point", "overlay.say" -> {
                String text = args.has("text") ? args.getString("text") : null;
                if (command.equals("overlay.say") && text == null) return PhoneResult.error("invalid_args", "text is required");
                if (text != null && text.length() > 2000) return PhoneResult.error("invalid_args", "Overlay text exceeds 2000 characters");
                long duration = args.optLong("durationMs", text == null ? 0 : Math.min(20000, 3000 + 50L * text.length()));
                if (duration < 0) return PhoneResult.error("invalid_args", "durationMs must be nonnegative");
                Rect bounds = null;
                float x = 0, y = 0;
                boolean target = args.has("nodeId") || args.has("x") || args.has("y") || args.has("left");
                if (command.equals("overlay.move") && (!args.has("x") || !args.has("y")))
                    return PhoneResult.error("invalid_args", "move needs x and y");
                if (command.equals("overlay.point") && !target) return PhoneResult.error("invalid_args", "point needs a target");
                if (args.has("nodeId")) {
                    bounds = resolve.apply(args.getString("nodeId"));
                    if (bounds == null) return PhoneResult.error("stale_node", "Read ui.tree again before pointing at this node");
                    x = bounds.exactCenterX(); y = bounds.exactCenterY();
                } else if (args.has("left")) {
                    bounds = new Rect(args.getInt("left"), args.getInt("top"), args.getInt("right"), args.getInt("bottom"));
                    if (bounds.isEmpty()) return PhoneResult.error("invalid_args", "Target bounds must have positive size");
                    x = bounds.exactCenterX(); y = bounds.exactCenterY();
                } else if (target) { x = (float) args.getDouble("x"); y = (float) args.getDouble("y"); }
                if (target && (!Float.isFinite(x) || !Float.isFinite(y) || x < 0 || y < 0 || x >= width() || y >= height()))
                    return PhoneResult.error("invalid_args", "Target must be within the display");
                if (command.equals("overlay.say")) setVisible(service, true);
                if (target) moveToTarget(x, y, 200);
                if (command.equals("overlay.point")) highlight(bounds, x, y, 5000);
                if (text != null) say(text, command.equals("overlay.say") ? duration : Math.min(20000, 3000 + text.length() * 50L));
            }
            default -> { return PhoneResult.error("unsupported", "Unknown overlay command"); }
        }
        return PhoneResult.success(new JSONObject());
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
    private int homeX() { return PhoneControlService.settings(service).getBoolean("overlayRight", true) ? width() - dp(54) : dp(6); }
    private int homeY() { return Math.round(PhoneControlService.settings(service).getFloat("overlayY", .42f) * (height() - dp(108))) + dp(36); }
    private void goHome() { if (!closed && !dragging) { scene.tip = false; fly(homeX(), homeY(), 320); } }
    private void activity() {
        if (closed) return;
        main.removeCallbacks(home);
        if (state.equals("idle") && gestures == 0) main.postDelayed(home, 6000);
    }
    private void position(int x, int y) {
        if (closed) return;
        dotAt.x = Math.max(0, Math.min(width() - dp(48), x));
        dotAt.y = Math.max(0, Math.min(height() - dp(48), y));
        windows.updateViewLayout(dot, dotAt); scene.invalidate();
    }
    private void fly(int x, int y, long duration) {
        if (flight != null) flight.cancel();
        if (duration == 0) { position(x, y); return; }
        int fromX = dotAt.x, fromY = dotAt.y;
        flight = ValueAnimator.ofFloat(0, 1); flight.setDuration(duration);
        flight.setInterpolator(new android.view.animation.DecelerateInterpolator());
        flight.addUpdateListener(frame -> {
            float t = (float) frame.getAnimatedValue();
            position(fromX + Math.round((x - fromX) * t), fromY + Math.round((y - fromY) * t));
        });
        flight.start();
    }
    void moveToTarget(float x, float y, long duration) {
        scene.tipX = x; scene.tipY = y; scene.tip = true;
        int offset = x > width() / 2f ? -dp(58) : dp(10);
        fly(Math.round(x) + offset, Math.round(y) - dp(58), duration); activity();
    }
    void highlight(Rect bounds, float x, float y, long duration) {
        main.removeCallbacks(clearHighlight);
        scene.highlight = bounds == null ? new RectF(x - dp(18), y - dp(18), x + dp(18), y + dp(18)) : new RectF(bounds);
        scene.pointHighlight = bounds == null; scene.invalidate();
        main.postDelayed(clearHighlight, duration); activity();
    }
    void highlight(Rect bounds) { highlight(bounds, bounds.exactCenterX(), bounds.exactCenterY(), 1500); moveToTarget(bounds.exactCenterX(), bounds.exactCenterY(), 0); }
    void gesture(float x, float y, float x2, float y2, long duration, boolean tap) {
        closePanel(); gestures++; touchability(); dot.invalidate(); main.removeCallbacks(home);
        scene.gestureX = x; scene.gestureY = y; scene.endX = x2; scene.endY = y2;
        scene.gestureStart = SystemClock.uptimeMillis(); scene.gestureDuration = duration;
        scene.tap = tap; scene.gestureUntil = scene.gestureStart + duration + 600; scene.invalidate();
    }
    void gestureFinished() { if (closed) return; if (gestures > 0) gestures--; touchability(); dot.invalidate(); activity(); }
    private void touchability() {
        if (closed) return;
        if (gestures > 0) dotAt.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else dotAt.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        windows.updateViewLayout(dot, dotAt);
        if (panel != null) {
            if (gestures > 0) panelAt.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            else panelAt.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            windows.updateViewLayout(panel, panelAt);
        }
    }
    void state(String next) { if (closed) return; state = next; dot.invalidate(); if (next.equals("idle")) activity(); else main.removeCallbacks(home); }
    void say(String text, long duration) {
        main.removeCallbacks(clearBubble);
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
        if (history != null) history.setText(TextUtils.join("\n\n", transcript));
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
        if (pending.isEmpty()) return;
        for (Runnable timeout : pending.values()) main.removeCallbacks(timeout);
        pending.clear(); error("Connection lost. Your message may not have reached Kenan.");
    }
    void resetSession() {
        closePanel(); main.removeCallbacksAndMessages(null); pending.clear(); transcript.clear(); threadId = null; draft = "";
        scene.words = null; scene.highlight = null; scene.tip = false; scene.gestureUntil = 0; state("idle"); goHome();
    }
    private void send() {
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
    private GradientDrawable card(int color) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(20));
        shape.setStroke(dp(1), 0xff46516f); return shape;
    }
    private Button button(String title, Runnable action) {
        Button button = new Button(service); button.setText(title); button.setTextColor(Color.WHITE);
        button.setAllCaps(false); button.setOnClickListener(view -> action.run()); return button;
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
        if (closed || gestures > 0 || captures > 0) return;
        if (panel != null) { closePanel(); return; }
        panel = new Panel(); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(16), dp(12), dp(16), dp(12));
        panel.setBackground(card(CARD)); panel.setElevation(dp(12));
        LinearLayout controls = new LinearLayout(service);
        controls.addView(button("Open in Kenan", () -> {
            Intent intent = new Intent(service, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            RemoteSession.Identity identity = NotificationIdentity.get(service).current();
            if (threadId != null && identity != null) intent.putExtra("sessionId", threadId).putExtra("user", identity.user)
                .putExtra("environment", PhoneControlService.settings(service).getString("environment", ""));
            closePanel(); service.startActivity(intent);
        }), new LinearLayout.LayoutParams(0, dp(48), 1));
        controls.addView(button("Close", this::closePanel)); panel.addView(controls);
        ScrollView scroll = new ScrollView(service);
        history = new TextView(service); history.setTextColor(Color.WHITE); history.setTextSize(15);
        history.setText(TextUtils.join("\n\n", transcript)); history.setPadding(0, dp(8), 0, dp(12));
        scroll.addView(history); panel.addView(scroll, new LinearLayout.LayoutParams(-1, dp(160)));
        input = new EditText(service); input.setTextColor(Color.WHITE); input.setHintTextColor(0xffb5bdd1);
        input.setHint("Talk to Kenan…"); input.setTextSize(16); input.setMinLines(2); input.setMaxLines(4);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(8000) }); input.setText(draft); panel.addView(input);
        panel.addView(button("Send", this::send));
        panelAt = new WindowManager.LayoutParams(-1, -2, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        panelAt.gravity = Gravity.BOTTOM;
        panelAt.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE;
        windows.addView(panel, panelAt); input.requestFocus();
        input.post(() -> {
            if (input == null) return;
            if (Build.VERSION.SDK_INT >= 33) backControl = new BackControl(panel, this::closePanel);
            ((InputMethodManager) service.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
        });
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }
    void closePanel() {
        if (panel == null) return;
        draft = input.getText().toString();
        if (backControl != null) { backControl.close(); backControl = null; }
        ((InputMethodManager) service.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(panel.getWindowToken(), 0);
        windows.removeView(panel); panel = null; panelAt = null; input = null; history = null;
    }
    void suspendCapture() { captures++; restoreVisibility(); }
    void restoreCapture() { if (captures > 0) captures--; restoreVisibility(); }
    private void restoreVisibility() {
        if (closed) return;
        scene.setVisibility(captures > 0 ? View.INVISIBLE : View.VISIBLE);
        dot.setVisibility(visible && captures == 0 ? View.VISIBLE : View.INVISIBLE);
        if (panel != null) panel.setVisibility(captures > 0 ? View.INVISIBLE : View.VISIBLE);
    }
    void close() {
        if (closed) return;
        closePanel(); closed = true; main.removeCallbacksAndMessages(null); pending.clear();
        if (flight != null) flight.cancel(); windows.removeView(dot); windows.removeView(scene);
    }
    private final class DotTouch implements View.OnTouchListener {
        private float downX, downY;
        private int startX, startY;
        @Override public boolean onTouch(View view, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN -> {
                    if (flight != null) flight.cancel(); main.removeCallbacks(home);
                    downX = event.getRawX(); downY = event.getRawY(); startX = dotAt.x; startY = dotAt.y;
                    dragging = false; return true;
                }
                case MotionEvent.ACTION_MOVE -> {
                    if (Math.hypot(event.getRawX() - downX, event.getRawY() - downY) > ViewConfiguration.get(service).getScaledTouchSlop()) dragging = true;
                    if (dragging) {
                        position(startX + Math.round(event.getRawX() - downX), startY + Math.round(event.getRawY() - downY));
                        boolean near = Math.hypot(dotAt.x + dp(24) - width() / 2f, dotAt.y + dp(24) - (height() - dp(72))) < dp(72);
                        if (near && !overDismiss) dot.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK);
                        overDismiss = near; scene.invalidate();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    boolean moved = dragging; boolean dismiss = moved && overDismiss && event.getActionMasked() == MotionEvent.ACTION_UP;
                    dragging = false; overDismiss = false; scene.invalidate();
                    if (dismiss) setVisible(service, false);
                    else if (moved) {
                        boolean right = dotAt.x + dp(24) > width() / 2;
                        PhoneControlService.settings(service).edit().putBoolean("overlayRight", right)
                            .putFloat("overlayY", Math.max(0, Math.min(1, (dotAt.y - dp(36)) / (float) (height() - dp(108))))).apply();
                        scene.tip = false; goHome();
                    } else if (event.getActionMasked() == MotionEvent.ACTION_UP) { dot.performClick(); openPanel(); }
                    return true;
                }
                default -> { return true; }
            }
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
            String animation = gestures > 0 ? "working" : state;
            float pulse = (float) (.5 + .5 * Math.sin(now / (animation.equals("working") ? 170.0 : 850.0)));
            paint.setStyle(Paint.Style.FILL); paint.setColor(ACCENT); paint.setAlpha(25 + Math.round(pulse * 35));
            canvas.drawCircle(cx, cy, dp(22), paint);
            paint.setColor(CARD); paint.setAlpha(255); canvas.drawCircle(cx, cy, dp(17), paint);
            paint.setColor(ACCENT); canvas.drawCircle(cx, cy, dp(7) + dp(1) * pulse, paint);
            if (animation.equals("thinking")) {
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2)); paint.setStrokeCap(Paint.Cap.ROUND);
                canvas.drawArc(cx - dp(13), cy - dp(13), cx + dp(13), cy + dp(13), (now % 1400) * 360f / 1400, 100, false, paint);
            }
            removeCallbacks(frame);
            postDelayed(frame, animation.equals("idle") ? 200 : 40);
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
            if (visible && tip) {
                paint.setStrokeWidth(dp(2)); paint.setColor(ACCENT); paint.setAlpha(170);
                canvas.drawLine(dotAt.x + dp(24), dotAt.y + dp(24), tipX, tipY, paint);
                canvas.drawCircle(tipX, tipY, dp(3), paint); paint.setAlpha(255);
            }
            if (visible && words != null) {
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
                paint.setStyle(Paint.Style.FILL); paint.setColor(overDismiss ? 0xffa44155 : CARD);
                canvas.drawCircle(width() / 2f, height() - dp(72), dp(26), paint);
                paint.setColor(Color.WHITE); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
                float cx = width() / 2f, cy = height() - dp(72);
                canvas.drawLine(cx - dp(7), cy - dp(7), cx + dp(7), cy + dp(7), paint);
                canvas.drawLine(cx - dp(7), cy + dp(7), cx + dp(7), cy - dp(7), paint);
            }
            if (highlight != null || now < gestureUntil) postInvalidateOnAnimation();
        }
    }
}

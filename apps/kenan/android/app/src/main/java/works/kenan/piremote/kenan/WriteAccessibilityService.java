package works.kenan.piremote.kenan;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.List;

/** One circular, focus-free control that can be moved while speech streams into the focused editor. */
public final class WriteAccessibilityService extends AccessibilityService {
    private static volatile WriteAccessibilityService active;
    static void sessionChanged() {
        WriteAccessibilityService service = active;
        if (service != null) service.main.post(() -> {
            if (active == service) { service.cancel(); service.hide(); service.refresh(); }
        });
    }
    private static final String CHANNEL = "write-recording";
    private static final int NOTIFICATION = 224;
    private static final int MAX_AUDIO_BYTES = 2_000_000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object packetsLock = new Object();
    private final List<byte[]> packets = new ArrayList<>();
    private WindowManager windows;
    private WindowManager.LayoutParams placement;
    private WriteBubblePosition.Bounds lastBounds;
    private Bubble bubble;
    private ValueAnimator snapAnimation;
    private AccessibilityNodeInfo target;
    private AccessibilityNodeInfo insertedNode;
    private String insertedField;
    private int insertedStart, insertedEnd, windowId = -1, audioBytes;
    private long watchUntil;
    private volatile long generation;
    private RemoteSession.Identity learnedIdentity;
    private WriteOpusRecorder recorder;
    private WriteConnection connection;
    private boolean recording, connecting, finishing, dragging, clipboardReady;
    private volatile boolean stopped;
    private volatile int sentPackets;
    private boolean backlog;
    private String failure;
    private int waveLevel;

    @Override public void onServiceConnected() {
        active = this;
        windows = getSystemService(WindowManager.class);
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Pi Stack Write", NotificationManager.IMPORTANCE_LOW));
        refresh();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED && insertedField != null
            && System.currentTimeMillis() < watchUntil && event.getWindowId() == windowId
            && event.getSource() != null && insertedNode != null && event.getSource().equals(insertedNode)) {
            String changed = event.getSource().getText() == null ? "" : event.getSource().getText().toString();
            WriteText.Correction correction = WriteText.changedWord(insertedField, changed, insertedStart, insertedEnd);
            if (correction != null && learnedIdentity != null) {
                insertedField = null;
                RemoteSession.Identity identity = learnedIdentity;
                WriteConnection.learn(this, identity, correction, learned -> {
                    if (learned != null && !learned.undoId().isBlank() && NotificationIdentity.get(this).isCurrent(identity))
                        WriteLearningNotice.show(this, identity, learned);
                });
            }
        }
        if (!recording && !finishing && !connecting) refresh();
        else if (!dragging) constrain();
    }

    private boolean hasKeyboard() {
        List<AccessibilityWindowInfo> visible = getWindows();
        if (visible != null) for (AccessibilityWindowInfo window : visible)
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        return false;
    }

    private boolean eligible(AccessibilityNodeInfo node) {
        if (node == null || !node.isEditable() || !node.isEnabled() || !node.isFocused()) return false;
        int input = node.getInputType();
        int variation = input & android.text.InputType.TYPE_MASK_VARIATION;
        int kind = input & android.text.InputType.TYPE_MASK_CLASS;
        if (kind == android.text.InputType.TYPE_CLASS_NUMBER || kind == android.text.InputType.TYPE_CLASS_PHONE) return false;
        if (kind == android.text.InputType.TYPE_CLASS_TEXT && (variation == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            || variation == android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            || variation == android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) return false;
        return !node.isPassword();
    }

    private void refresh() {
        if (windows == null) return;
        RemoteSession.Identity identity = NotificationIdentity.get(this).current();
        boolean allowed = identity != null && Settings.canDrawOverlays(this)
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        AccessibilityNodeInfo focused = null;
        List<AccessibilityWindowInfo> visible = getWindows();
        if (visible != null) for (AccessibilityWindowInfo window : visible) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION || window.getRoot() == null) continue;
            AccessibilityNodeInfo candidate = window.getRoot().findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (eligible(candidate)) { focused = candidate; break; }
        }
        if (focused == null && getRootInActiveWindow() != null)
            focused = getRootInActiveWindow().findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        boolean keyboardRequired = getSharedPreferences("write-settings", 0).getBoolean("keyboardRequired", true);
        if (!allowed || !eligible(focused) || keyboardRequired && !hasKeyboard()) {
            if (bubble != null && !recording && !finishing && !connecting) hide();
            return;
        }
        target = focused;
        windowId = focused.getWindowId();
        if (bubble == null) show(); else constrain();
    }

    private int dp(float pixels) { return (int) (getResources().getDisplayMetrics().density * pixels + .5f); }
    private int diameter() { return dp(56); }

    private WriteBubblePosition.Bounds available() {
        int left, top, right, bottom;
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
        } else {
            android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
            left = dp(6); top = dp(30); right = metrics.widthPixels - dp(6); bottom = metrics.heightPixels - dp(30);
        }
        List<AccessibilityWindowInfo> visible = getWindows();
        if (visible != null) for (AccessibilityWindowInfo window : visible) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
            Rect keyboard = new Rect();
            window.getBoundsInScreen(keyboard);
            if (keyboard.top > top + diameter() && keyboard.bottom >= bottom - dp(80))
                bottom = Math.min(bottom, keyboard.top - dp(8));
        }
        return new WriteBubblePosition.Bounds(left, top, Math.max(left + diameter(), right),
            Math.max(top + diameter(), bottom));
    }

    private void show() {
        bubble = new Bubble();
        placement = new WindowManager.LayoutParams(diameter(), diameter(), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT);
        placement.gravity = Gravity.TOP | Gravity.LEFT;
        WriteBubblePosition.Bounds bounds = available();
        lastBounds = bounds;
        boolean right = getSharedPreferences("write-settings", 0).getBoolean("bubbleRight", true);
        float y = getSharedPreferences("write-settings", 0).getFloat("bubbleY", .48f);
        placement.x = right ? bounds.right() - diameter() : bounds.left();
        placement.y = WriteBubblePosition.restoreY(y, bounds, diameter());
        windows.addView(bubble, placement);
        bubble.setOnTouchListener(new BubbleTouch());
        render();
    }

    private void move(int x, int y) {
        if (bubble == null || placement == null) return;
        WriteBubblePosition.Point at = WriteBubblePosition.clamp(x, y, available(), diameter());
        if (placement.x == at.x() && placement.y == at.y()) return;
        placement.x = at.x(); placement.y = at.y();
        windows.updateViewLayout(bubble, placement);
    }
    private void constrain() {
        if (bubble == null || dragging) return;
        WriteBubblePosition.Bounds bounds = available();
        if (!bounds.equals(lastBounds)) {
            lastBounds = bounds;
            if (snapAnimation != null) snapAnimation.cancel();
            boolean right = getSharedPreferences("write-settings", 0).getBoolean("bubbleRight", true);
            float y = getSharedPreferences("write-settings", 0).getFloat("bubbleY", .48f);
            move(right ? bounds.right() - diameter() : bounds.left(),
                WriteBubblePosition.restoreY(y, bounds, diameter()));
        } else move(placement.x, placement.y);
    }
    private void snap(float velocityX) {
        if (bubble == null) return;
        WriteBubblePosition.Bounds bounds = available();
        lastBounds = bounds;
        WriteBubblePosition.Point edge = WriteBubblePosition.snap(placement.x, placement.y, bounds, diameter(), velocityX);
        if (snapAnimation != null) snapAnimation.cancel();
        int startX = placement.x, startY = placement.y;
        snapAnimation = ValueAnimator.ofFloat(0, 1);
        snapAnimation.setDuration(180);
        snapAnimation.setInterpolator(new android.view.animation.DecelerateInterpolator());
        snapAnimation.addUpdateListener(animator -> {
            float t = (float) animator.getAnimatedValue();
            move(startX + Math.round((edge.x() - startX) * t), startY + Math.round((edge.y() - startY) * t));
        });
        snapAnimation.start();
        getSharedPreferences("write-settings", 0).edit()
            .putBoolean("bubbleRight", edge.x() != bounds.left())
            .putFloat("bubbleY", WriteBubblePosition.saveY(edge.y(), bounds, diameter())).apply();
    }

    private final class BubbleTouch implements View.OnTouchListener {
        private float downX, downY;
        private int startX, startY;
        private VelocityTracker velocity;
        private boolean moved;
        private void addRawMovement(MotionEvent event) {
            if (velocity == null) return;
            MotionEvent screen = MotionEvent.obtain(event);
            screen.setLocation(event.getRawX(), event.getRawY());
            velocity.addMovement(screen);
            screen.recycle();
        }
        @Override public boolean onTouch(View view, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN -> {
                    if (snapAnimation != null) snapAnimation.cancel();
                    downX = event.getRawX(); downY = event.getRawY();
                    startX = placement.x; startY = placement.y;
                    moved = false;
                    velocity = VelocityTracker.obtain(); addRawMovement(event);
                    return true;
                }
                case MotionEvent.ACTION_MOVE -> {
                    addRawMovement(event);
                    if (!moved && WriteBubblePosition.dragged(downX, downY, event.getRawX(), event.getRawY(),
                        ViewConfiguration.get(WriteAccessibilityService.this).getScaledTouchSlop())) moved = true;
                    if (moved) {
                        dragging = true;
                        move(startX + Math.round(event.getRawX() - downX), startY + Math.round(event.getRawY() - downY));
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    float vx = 0;
                    if (velocity != null) {
                        addRawMovement(event); velocity.computeCurrentVelocity(1000);
                        vx = velocity.getXVelocity(); velocity.recycle(); velocity = null;
                    }
                    dragging = false;
                    if (moved) snap(vx);
                    else if (event.getActionMasked() == MotionEvent.ACTION_UP) tapped();
                    return true;
                }
                default -> { return true; }
            }
        }
    }

    private void hide() {
        if (snapAnimation != null) { snapAnimation.cancel(); snapAnimation = null; }
        if (bubble == null) return;
        windows.removeView(bubble);
        bubble = null;
        target = null;
        windowId = -1;
    }

    private void tapped() {
        if (finishing) return;
        if (recording) { finish(); return; }
        if (clipboardReady && target != null && eligible(target)
            && target.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
            clipboardReady = false; failure = null; render(); return;
        }
        if (!connecting) {
            boolean retry;
            synchronized (packetsLock) { retry = failure != null && !packets.isEmpty(); }
            start(retry);
        }
    }

    private void render() {
        if (bubble == null) return;
        bubble.setContentDescription(finishing ? "Finishing dictation" : recording ? "Tap to finish Pi Stack Write"
            : clipboardReady ? "Tap to paste dictated text" : failure == null ? "Tap to start Pi Stack Write" : "Tap to retry Pi Stack Write");
        bubble.invalidate();
    }

    private void start(boolean retry) {
        RemoteSession.Identity identity = NotificationIdentity.get(this).current();
        if (identity == null || target == null || !eligible(target)) {
            failMessage("Select an editable field"); return;
        }
        if (!retry) synchronized (packetsLock) { packets.clear(); audioBytes = 0; }
        failure = null; clipboardReady = false; waveLevel = 0; backlog = false;
        long attempt = ++generation;
        connecting = true; stopped = retry; sentPackets = 0;
        render();
        if (connection != null) connection.cancel();
        CharSequence field = target.getText();
        int cursor = target.getTextSelectionStart();
        String text = field == null ? "" : field.toString();
        int end = Math.max(0, Math.min(text.length(), cursor < 0 ? text.length() : cursor));
        String context = text.substring(Math.max(0, end - 200), end);
        WriteConnection stream = new WriteConnection(this, identity, new WriteConnection.Events() {
            @Override public void connected() { main.post(() -> {
                if (attempt != generation || !connecting || !NotificationIdentity.get(WriteAccessibilityService.this).isCurrent(identity)) return;
                connecting = false;
                sendPackets(attempt, connection);
                render();
            }); }
            @Override public void partial(String text) { }
            @Override public void finished(String text) { main.post(() -> { if (attempt == generation) completed(text); }); }
            @Override public void failed(String message) { main.post(() -> { if (attempt == generation) failed(message); }); }
        });
        connection = stream;
        if (!retry) startRecorder(attempt, stream);
        if (connecting) stream.connect(context);
    }

    private void sendPackets(long attempt, WriteConnection stream) {
        new Thread(() -> {
            int index = 0;
            long backedUpAt = 0;
            try {
                while (attempt == generation) {
                    byte[] packet;
                    synchronized (packetsLock) {
                        while (attempt == generation && index == packets.size() && !stopped) packetsLock.wait(80);
                        if (attempt != generation) return;
                        if (index == packets.size() && stopped) break;
                        packet = packets.get(index);
                    }
                    if (stream.queueSize() > 6000) {
                        if (backedUpAt == 0) backedUpAt = android.os.SystemClock.uptimeMillis();
                        if (android.os.SystemClock.uptimeMillis() - backedUpAt > 3000)
                            throw new java.io.IOException("Network cannot keep up; tap to retry");
                        Thread.sleep(20);
                        continue;
                    }
                    backedUpAt = 0;
                    if (!stream.audio(packet)) throw new java.io.IOException("Dictation connection closed; tap to retry");
                    sentPackets = ++index;
                }
                main.post(() -> {
                    if (attempt != generation) return;
                    finishing = true; recording = false;
                    stream.finish();
                    render();
                    main.postDelayed(() -> {
                        if (attempt == generation && finishing) failed("Server did not finish; tap to retry");
                    }, 5000);
                });
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (java.io.IOException error) { main.post(() -> {
                if (attempt == generation) failed(error.getMessage());
            }); }
        }, "write-opus-stream").start();
    }

    private void startRecorder(long attempt, WriteConnection stream) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            failed("Microphone permission is missing"); return;
        }
        try {
            Notification foreground = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Pi Stack Write is listening").setOngoing(true).build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, foreground, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION, foreground);
            recording = true;
            recorder = new WriteOpusRecorder(new WriteOpusRecorder.Listener() {
                @Override public void packet(byte[] packet) {
                    synchronized (packetsLock) {
                        if (attempt != generation) return;
                        if (packets.size() >= 6000 || audioBytes + packet.length > MAX_AUDIO_BYTES) {
                            main.post(() -> { if (attempt == generation) failed("Recording exceeded two minutes"); }); return;
                        }
                        packets.add(packet); audioBytes += packet.length;
                        packetsLock.notifyAll();
                    }
                }
                @Override public void amplitude(int level) { main.post(() -> {
                    if (attempt != generation) return;
                    waveLevel = level;
                    long queue = stream.queueSize();
                    synchronized (packetsLock) { backlog = queue > 3000 || packets.size() - sentPackets > 50; }
                    render();
                }); }
                @Override public void stopped() {
                    if (attempt != generation) return;
                    synchronized (packetsLock) { stopped = true; packetsLock.notifyAll(); }
                    main.post(() -> { if (attempt == generation) stopForeground(STOP_FOREGROUND_REMOVE); });
                }
                @Override public void failed(String message) { main.post(() -> {
                    if (attempt == generation) WriteAccessibilityService.this.failed(message);
                }); }
            });
            recorder.start();
        } catch (RuntimeException error) { failed("Could not start microphone: " + error.getMessage()); }
    }

    private void finish() {
        if (!recording) return;
        recording = false;
        finishing = true;
        if (recorder != null) recorder.stop();
        render();
    }

    private void stopRecorder() {
        recording = false;
        if (recorder != null) recorder.stop();
        recorder = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void cancel() {
        stopRecorder();
        if (connection != null) connection.cancel();
        connection = null;
        ++generation;
        connecting = false; finishing = false; stopped = false;
        clipboardReady = false; failure = null; backlog = false;
        synchronized (packetsLock) { packets.clear(); audioBytes = 0; }
        render(); refresh();
    }

    private void failMessage(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void failed(String message) {
        if (!recording && !finishing && !connecting) return;
        stopRecorder();
        if (connection != null) connection.cancel();
        connecting = false; finishing = false; failure = message;
        ++generation;
        failMessage("Pi Stack Write: " + message);
        render();
    }

    private void completed(String text) {
        if (!finishing && !recording) return;
        stopRecorder();
        finishing = false; connecting = false;
        if (text == null || text.isBlank()) { failure = "No speech recognized"; failMessage(failure); render(); return; }
        AccessibilityNodeInfo node = target;
        if (node == null || !eligible(node) || node.getWindowId() != windowId) { fallback(text); return; }
        String original = node.getText() == null ? "" : node.getText().toString();
        WriteText.Insertion result = WriteText.insert(original, node.getTextSelectionStart(), node.getTextSelectionEnd(), text);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, result.text());
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            Bundle selection = new Bundle();
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, result.end());
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, result.end());
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
            insertedField = result.text(); insertedNode = node;
            insertedStart = result.start(); insertedEnd = result.end();
            watchUntil = System.currentTimeMillis() + 20_000;
            learnedIdentity = NotificationIdentity.get(this).current();
            synchronized (packetsLock) { packets.clear(); audioBytes = 0; }
            failure = null; backlog = false; render(); refresh();
        } else fallback(text);
    }

    private void fallback(String text) {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Pi Stack Write", text));
        clipboardReady = true; failure = null;
        synchronized (packetsLock) { packets.clear(); audioBytes = 0; }
        failMessage("Write copied text. Tap the bubble to paste.");
        render();
    }

    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); constrain(); }
    @Override public void onInterrupt() { cancel(); hide(); }
    @Override public void onDestroy() {
        if (active == this) active = null;
        cancel(); hide(); super.onDestroy();
    }

    private final class Bubble extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Bubble() { super(WriteAccessibilityService.this); setElevation(dp(8)); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            float scale = getResources().getDisplayMetrics().density;
            boolean busy = finishing || (connecting && !recording);
            float pulse = (float) (Math.sin(android.os.SystemClock.uptimeMillis() / 160.0) * .5 + .5);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(failure != null ? 0xffa63741 : backlog ? 0xff555b71 : 0xff242b40);
            canvas.drawCircle(cx, cy, Math.min(cx, cy) - scale, paint);
            paint.setColor(Color.WHITE);
            paint.setStrokeWidth(2.7f * scale);
            paint.setStrokeCap(Paint.Cap.ROUND);
            if (busy) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setAlpha(110 + Math.round(140 * pulse));
                canvas.drawArc(cx - 13 * scale, cy - 13 * scale, cx + 13 * scale, cy + 13 * scale,
                    -90, 110 + 120 * pulse, false, paint);
                paint.setAlpha(255);
            } else if (recording) {
                float[] bars = { .4f, .7f, 1f, .55f, .8f };
                for (int i = 0; i < bars.length; i++) {
                    float h = (4 + waveLevel * 1.6f * bars[i]) * scale;
                    float x = cx + (i - 2) * 6 * scale;
                    canvas.drawLine(x, cy - h, x, cy + h, paint);
                }
            } else if (clipboardReady) {
                paint.setStyle(Paint.Style.STROKE);
                canvas.drawRoundRect(cx - 8 * scale, cy - 11 * scale, cx + 8 * scale, cy + 11 * scale,
                    2 * scale, 2 * scale, paint);
                canvas.drawLine(cx - 4 * scale, cy - 3 * scale, cx + 4 * scale, cy - 3 * scale, paint);
                canvas.drawLine(cx - 4 * scale, cy + 2 * scale, cx + 4 * scale, cy + 2 * scale, paint);
            } else {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawRoundRect(cx - 5 * scale, cy - 11 * scale, cx + 5 * scale, cy + 5 * scale,
                    5 * scale, 5 * scale, paint);
                paint.setStyle(Paint.Style.STROKE);
                canvas.drawArc(cx - 9 * scale, cy - 5 * scale, cx + 9 * scale, cy + 10 * scale, 0, 180, false, paint);
                canvas.drawLine(cx, cy + 10 * scale, cx, cy + 14 * scale, paint);
            }
            if (busy) postInvalidateDelayed(55);
        }
    }
}

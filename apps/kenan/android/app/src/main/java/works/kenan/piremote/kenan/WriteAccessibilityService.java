package works.kenan.piremote.kenan;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.Toast;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.List;

public final class WriteAccessibilityService extends AccessibilityService {
    private static volatile WriteAccessibilityService active;
    static void sessionChanged() {
        WriteAccessibilityService service = active;
        if (service != null) service.main.post(() -> {
            if (active == service) { service.clearLearning(); service.dismissal.clear(); service.cancel(); service.hide(); service.refresh(); }
        });
    }
    static void settingsChanged() {
        WriteAccessibilityService service = active;
        if (service == null) return;
        Runnable update = () -> { if (active == service) service.refresh(); };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run();
        else service.main.post(update);
    }
    private boolean overlayEnabled() {
        return getSharedPreferences("write-settings", 0).getBoolean("overlayEnabled", true);
    }
    private static final String CHANNEL = "write-recording";
    private static final int NOTIFICATION = 224;
    private static final int MAX_AUDIO_BYTES = 2_000_000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object packetsLock = new Object();
    private final List<byte[]> packets = new ArrayList<>();
    private final WriteFieldDismissal dismissal = new WriteFieldDismissal();
    private AccessibilityNodeInfo target;
    private AccessibilityNodeInfo insertedNode;
    private String insertedField;
    private int insertedStart, insertedEnd, windowId = -1, audioBytes;
    private long watchUntil;
    private int insertedWindowId = -1;
    private final Runnable expireLearning = this::clearLearning;
    private void clearLearning() {
        main.removeCallbacks(expireLearning);
        insertedField = null; insertedNode = null; learnedIdentity = null;
        insertedStart = 0; insertedEnd = 0; insertedWindowId = -1; watchUntil = 0;
    }
    private volatile long generation;
    private RemoteSession.Identity learnedIdentity;
    private WriteOpusRecorder recorder;
    private WriteConnection connection;
    private boolean shown;
    private NativeState.WritePhase phase = NativeState.WritePhase.IDLE;
    private volatile boolean stopped;
    private boolean destroyed;
    private volatile int sentPackets;
    private boolean backlog;
    private int waveLevel;

    @Override public void onServiceConnected() {
        active = this;
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Pi Stack Write", NotificationManager.IMPORTANCE_LOW));
        SharedOverlay.write(this);
        refresh();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (destroyed) return;
        if (!overlayEnabled()) { refresh(); return; }
        if (SharedOverlay.overlayWindow(event.getWindowId())) return;
        if (dismissal.active() && event.getEventType() == AccessibilityEvent.TYPE_VIEW_FOCUSED
            && isApplicationWindow(event.getWindowId())) {
            AccessibilityNodeInfo source = event.getSource();
            if (source != null) {
                WriteFieldDismissal.Field focused = field(source);
                dismissal.focusLeft(focused);
                if (eligible(source)) dismissal.hides(focused, true);
            }
        }
        AccessibilityNodeInfo changedNode = event.getEventType() == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
            && insertedField != null && android.os.SystemClock.uptimeMillis() < watchUntil && event.getWindowId() == insertedWindowId
            ? event.getSource() : null;
        if (changedNode != null && insertedNode != null && changedNode.equals(insertedNode)) {
            String changed = fieldText(changedNode);
            WriteText.Correction correction = WriteText.changedWord(insertedField, changed, insertedStart, insertedEnd);
            if (correction != null && learnedIdentity != null) {
                RemoteSession.Identity identity = learnedIdentity;
                clearLearning();
                WriteConnection.learn(this, identity, correction, learned -> {
                    if (learned != null && !learned.undoId().isBlank() && NotificationIdentity.get(this).isCurrent(identity))
                        WriteLearningNotice.show(this, identity, learned);
                });
            }
        }
        int type = event.getEventType();
        if (type == AccessibilityEvent.TYPE_WINDOWS_CHANGED || type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
            SharedOverlay.requestRefresh(!busy());
        else if (!SharedOverlay.inputMethodWindow(event.getWindowId())
            && (type == AccessibilityEvent.TYPE_VIEW_FOCUSED || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && (event.getContentChangeTypes() == 0 || (event.getContentChangeTypes() & AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE) != 0)))
            SharedOverlay.requestRefresh(!busy());
    }

    private boolean isApplicationWindow(int id) {
        List<AccessibilityWindowInfo> visible = getWindows();
        if (visible != null) for (AccessibilityWindowInfo window : visible)
            if (window.getId() == id) return window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION;
        return false;
    }

    private WriteFieldDismissal.Field field(AccessibilityNodeInfo node) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return new WriteFieldDismissal.Field(node, node.getWindowId(), node.getViewIdResourceName(),
            bounds.left, bounds.top, bounds.right, bounds.bottom);
    }

    private boolean hasKeyboard() {
        List<AccessibilityWindowInfo> visible = getWindows();
        if (visible != null) for (AccessibilityWindowInfo window : visible)
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        return false;
    }

    static String fieldText(AccessibilityNodeInfo node) {
        if (Build.VERSION.SDK_INT >= 26 && node.isShowingHintText()) return "";
        CharSequence text = node.getText();
        return text == null ? "" : text.toString();
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

    void reconcileFocus() { refresh(); }
    private void refresh() {
        if (active != this || destroyed) return;
        if (!overlayEnabled()) {
            if (busy() || phase.clipboard) cancel();
            hide();
            return;
        }
        if (busy()) { SharedOverlay.refresh(); return; }
        RemoteSession.Identity identity = NotificationIdentity.get(this).current();
        boolean allowed = identity != null && Settings.canDrawOverlays(this)
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!allowed) { hide(); return; }
        boolean keyboardRequired = getSharedPreferences("write-settings", 0).getBoolean("keyboardRequired", true);
        if (keyboardRequired && !hasKeyboard()) { hide(); return; }
        AccessibilityNodeInfo focused = target != null && target.refresh() && eligible(target) ? target : null;
        List<AccessibilityWindowInfo> visible = focused == null ? getWindows() : null;
        if (visible != null) for (AccessibilityWindowInfo window : visible) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            // getRoot() fetches a fresh snapshot each call and can turn null between calls.
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            AccessibilityNodeInfo candidate = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (eligible(candidate)) { focused = candidate; break; }
        }
        if (focused == null) {
            AccessibilityNodeInfo activeRoot = getRootInActiveWindow();
            if (activeRoot != null) focused = activeRoot.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }
        if (!eligible(focused) || focused != null && dismissal.hides(field(focused), false)) {
            if (!busy()) hide();
            return;
        }
        target = focused;
        windowId = focused.getWindowId();
        shown = true;
        SharedOverlay.refresh();
    }

    void overlayUnavailable() {
        shown = false;
        if (busy()) failed("Overlay window is no longer available");
    }
    boolean visible() { return shown && overlayEnabled(); }
    boolean busy() { return phase.busy(); }
    boolean canDismiss() { return !busy(); }
    void dismiss() {
        if (!canDismiss()) return;
        if (target != null) dismissal.dismiss(field(target));
        hide();
    }
    private void hide() {
        shown = false;
        target = null;
        windowId = -1;
        SharedOverlay.refresh();
    }
    void tapped() {
        if (!overlayEnabled()) { refresh(); return; }
        Runnable tap = switch (phase) {
            case FINISHING, FINISHING_CONNECTING, CONNECTING -> () -> { }; // These phases must settle before another tap.
            case RECORDING, BUFFERING -> this::finish;
            case CLIPBOARD_READY -> () -> {
                if (target != null && eligible(target) && target.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
                    phase = NativeState.WritePhase.IDLE; render();
                } else start();
            };
            case IDLE -> this::start;
        };
        tap.run();
    }
    String visualState() { return phase + ":" + waveLevel + ":" + backlog; }
    boolean animates() { return phase.connecting || phase.finishing; }
    String description() {
        return switch (phase) {
            case FINISHING, FINISHING_CONNECTING -> "Finishing dictation";
            case RECORDING, BUFFERING -> "Tap to finish Pi Stack Write";
            case CONNECTING -> "Connecting Pi Stack Write";
            case CLIPBOARD_READY -> "Tap to paste dictated text";
            case IDLE -> "Tap to start Pi Stack Write";
        };
    }
    private void render() { SharedOverlay.refresh(); }

    private void start() {
        RemoteSession.Identity identity = NotificationIdentity.get(this).current();
        if (identity == null || target == null || !target.refresh() || !eligible(target)) return;
        clearLearning();
        synchronized (packetsLock) { packets.clear(); audioBytes = 0; }
        waveLevel = 0; backlog = false;
        long attempt = ++generation;
        phase = NativeState.WritePhase.CONNECTING; stopped = false; sentPackets = 0;
        render();
        if (connection != null) connection.cancel();
        String text = fieldText(target);
        int cursor = target.getTextSelectionStart();
        int end = Math.max(0, Math.min(text.length(), cursor < 0 ? text.length() : cursor));
        String context = text.substring(Math.max(0, end - 200), end);
        WriteConnection stream = new WriteConnection(this, identity, new WriteConnection.Events() {
            @Override public void connected() { main.post(() -> {
                if (attempt != generation || !phase.connecting || !NotificationIdentity.get(WriteAccessibilityService.this).isCurrent(identity)) return;
                phase = phase.connected();
                sendPackets(attempt, connection);
                render();
            }); }
            @Override public void partial(String text) { }
            @Override public void notice(String message) { main.post(() -> {
                if (attempt == generation) Toast.makeText(WriteAccessibilityService.this, message, Toast.LENGTH_LONG).show();
            }); }
            @Override public void finished(String text) { main.post(() -> { if (attempt == generation) completed(text); }); }
            @Override public void failed(String message) { main.post(() -> { if (attempt == generation) failed(message); }); }
        });
        connection = stream;
        startRecorder(attempt, stream);
        if (phase.connecting) stream.connect(context);
    }

    private void sendPackets(long attempt, WriteConnection stream) {
        new Thread(() -> {
            int index = 0;
            long backedUpAt = 0;
            try {
                while (attempt == generation) {
                    byte[] packet;
                    synchronized (packetsLock) {
                        while (attempt == generation && index == packets.size() && !stopped) packetsLock.wait();
                        if (attempt != generation) return;
                        if (index == packets.size() && stopped) break;
                        packet = packets.get(index);
                    }
                    if (stream.queueSize() > 6000) {
                        if (backedUpAt == 0) backedUpAt = android.os.SystemClock.uptimeMillis();
                        if (android.os.SystemClock.uptimeMillis() - backedUpAt > 3000)
                            throw new java.io.IOException("Network cannot keep up");
                        Thread.sleep(20);
                        continue;
                    }
                    backedUpAt = 0;
                    if (!stream.audio(packet)) throw new java.io.IOException("Dictation connection closed");
                    sentPackets = ++index;
                }
                main.post(() -> {
                    if (attempt != generation) return;
                    phase = NativeState.WritePhase.FINISHING;
                    stream.finish();
                    render();
                    main.postDelayed(() -> {
                        if (attempt == generation && phase.finishing) failed("Server did not finish");
                    }, 30000);
                });
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (java.io.IOException error) { main.post(() -> {
                if (attempt == generation && !stream.ended()) failed(error.getMessage());
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
            phase = NativeState.WritePhase.BUFFERING;
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
                    long queue = stream.queueSize();
                    boolean nextBacklog;
                    synchronized (packetsLock) { nextBacklog = queue > 3000 || packets.size() - sentPackets > 50; }
                    if (waveLevel != level || backlog != nextBacklog) {
                        waveLevel = level; backlog = nextBacklog; render();
                    }
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
        if (!phase.recording) return;
        phase = phase.finish();
        if (recorder != null) recorder.stop();
        render();
    }
    private void stopRecorder() {
        phase = NativeState.WritePhase.IDLE;
        if (recorder != null) recorder.cancel();
        recorder = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
    }
    private void retireAttempt() {
        ++generation;
        stopRecorder();
        if (connection != null) connection.cancel();
        connection = null;
        synchronized (packetsLock) { packets.clear(); audioBytes = 0; packetsLock.notifyAll(); }
    }
    private void idle() {
        retireAttempt();
        phase = NativeState.WritePhase.IDLE; stopped = false; backlog = false;
        render(); refresh();
    }
    private void cancel() { idle(); }
    private void failed(String message) {
        if (!busy()) return;
        Log.w("PiStackWrite", "Dictation ended: " + message);
        SharedOverlay.haptic();
        idle();
    }
    private void completed(String text) {
        if (!overlayEnabled()) { refresh(); return; }
        if (!phase.finishing && !phase.recording) return;
        retireAttempt();
        if (text == null || text.isBlank()) { idle(); return; }
        AccessibilityNodeInfo node = target;
        if (node == null || !node.refresh() || !eligible(node) || node.getWindowId() != windowId) { fallback(text); return; }
        String original = fieldText(node);
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
            insertedWindowId = node.getWindowId();
            watchUntil = android.os.SystemClock.uptimeMillis() + 20_000;
            learnedIdentity = NotificationIdentity.get(this).current();
            main.removeCallbacks(expireLearning);
            main.postDelayed(expireLearning, 20_000);
            backlog = false; render(); refresh();
        } else fallback(text);
    }
    private void fallback(String text) {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Pi Stack Write", text));
        phase = NativeState.WritePhase.CLIPBOARD_READY;
        backlog = false;
        Toast.makeText(this, "Write copied text. Tap the dot to paste.", Toast.LENGTH_LONG).show();
        render();
    }

    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); if (!destroyed) SharedOverlay.requestRefresh(true); }
    @Override public void onInterrupt() { clearLearning(); cancel(); hide(); }
    @Override public void onDestroy() {
        destroyed = true;
        clearLearning();
        if (active == this) active = null;
        cancel(); hide(); SharedOverlay.detach(this); super.onDestroy();
    }

    void draw(Canvas canvas, Paint paint, float cx, float cy, float scale) {
        float pulse = (float) (Math.sin(android.os.SystemClock.uptimeMillis() / 160.0) * .5 + .5);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(backlog ? 0xff555b71 : 0xff242b40);
        canvas.drawCircle(cx, cy, Math.min(cx, cy) - 3 * scale, paint);
        paint.setColor(Color.WHITE);
        paint.setStrokeWidth(2.7f * scale);
        paint.setStrokeCap(Paint.Cap.ROUND);
        Runnable draw = switch (phase) {
            case CONNECTING, FINISHING, FINISHING_CONNECTING -> () -> {
                paint.setStyle(Paint.Style.STROKE);
                paint.setAlpha(110 + Math.round(140 * pulse));
                canvas.drawArc(cx - 13 * scale, cy - 13 * scale, cx + 13 * scale, cy + 13 * scale,
                    -90, 110 + 120 * pulse, false, paint);
                paint.setAlpha(255);
            };
            case RECORDING, BUFFERING -> () -> {
                float[] bars = { .4f, .7f, 1f, .55f, .8f };
                for (int i = 0; i < bars.length; i++) {
                    float h = (4 + waveLevel * 1.6f * bars[i]) * scale;
                    float x = cx + (i - 2) * 6 * scale;
                    canvas.drawLine(x, cy - h, x, cy + h, paint);
                }
            };
            case CLIPBOARD_READY -> () -> {
                paint.setStyle(Paint.Style.STROKE);
                canvas.drawRoundRect(cx - 8 * scale, cy - 11 * scale, cx + 8 * scale, cy + 11 * scale,
                    2 * scale, 2 * scale, paint);
                canvas.drawLine(cx - 4 * scale, cy - 3 * scale, cx + 4 * scale, cy - 3 * scale, paint);
                canvas.drawLine(cx - 4 * scale, cy + 2 * scale, cx + 4 * scale, cy + 2 * scale, paint);
            };
            case IDLE -> () -> {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawRoundRect(cx - 5 * scale, cy - 11 * scale, cx + 5 * scale, cy + 5 * scale,
                    5 * scale, 5 * scale, paint);
                paint.setStyle(Paint.Style.STROKE);
                canvas.drawArc(cx - 9 * scale, cy - 5 * scale, cx + 9 * scale, cy + 10 * scale, 0, 180, false, paint);
                canvas.drawLine(cx, cy + 10 * scale, cx, cy + 14 * scale, paint);
            };
        };
        draw.run();
    }
}

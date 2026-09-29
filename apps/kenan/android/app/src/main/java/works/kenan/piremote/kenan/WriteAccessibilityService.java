package works.kenan.piremote.kenan;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.List;

/** System-wide dictation UI; the overlay never takes input focus away from the editor. */
public final class WriteAccessibilityService extends AccessibilityService {
    private static final String CHANNEL = "write-recording";
    private static final int NOTIFICATION = 224;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager windows;
    private WindowManager.LayoutParams placement;
    private LinearLayout bubble;
    private TextView trigger, done, cancel, status;
    private AccessibilityNodeInfo target;
    private int windowId = -1;
    private AudioRecord recorder;
    private Thread recorderThread;
    private WriteConnection connection;
    private boolean recording, processing, connecting, replaying, pendingFinish;
    private volatile boolean streamReady;
    private boolean keyboardVisible, clipboardReady;
    private long generation;
    private String failure;
    private String partialText = "";
    private String waveform = "▁▁▁▁▁▁▁▁";
    private long lastWave;
    private final List<byte[]> captured = new ArrayList<>();
    private int capturedBytes;
    private String insertedField;
    private AccessibilityNodeInfo insertedNode;
    private int insertedStart, insertedEnd;
    private long watchUntil;
    private RemoteSession.Identity learnedIdentity;

    @Override public void onServiceConnected() {
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
        if (!recording && !processing && !connecting) refresh();
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
        int variation = input & InputType.TYPE_MASK_VARIATION;
        int kind = input & InputType.TYPE_MASK_CLASS;
        if (kind == InputType.TYPE_CLASS_NUMBER || kind == InputType.TYPE_CLASS_PHONE) return false;
        if (kind == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
            || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            || variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS && node.isPassword())) return false;
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
        keyboardVisible = hasKeyboard();
        boolean keyboardRequired = getSharedPreferences("write-settings", 0).getBoolean("keyboardRequired", true);
        if (!allowed || !eligible(focused) || keyboardRequired && !keyboardVisible) {
            if (bubble != null && !recording && !processing && !connecting) hide();
            return;
        }
        target = focused;
        windowId = focused.getWindowId();
        if (bubble == null) show();
    }

    private TextView control(String text, int size) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(Color.WHITE);
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(42));
        view.setMinHeight(dp(48));
        return view;
    }
    private int dp(float value) { return (int) (getResources().getDisplayMetrics().density * value + .5f); }

    private void show() {
        bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.HORIZONTAL);
        bubble.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xff22283c);
        background.setCornerRadius(dp(32));
        bubble.setBackground(background);
        bubble.setElevation(dp(8));
        trigger = control("✦", 27);
        done = control("✓", 27);
        cancel = control("✗", 24);
        status = control("", 13);
        status.setMaxWidth(dp(210));
        status.setSingleLine(true);
        status.setEllipsize(TextUtils.TruncateAt.END);
        status.setPadding(dp(7), 0, dp(7), 0);
        bubble.addView(trigger);
        bubble.addView(status);
        bubble.addView(done);
        bubble.addView(cancel);
        trigger.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int initialX, initialY;
            long downAt;
            boolean moved, initiated;
            @Override public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN -> {
                        downX = event.getRawX(); downY = event.getRawY();
                        downAt = android.os.SystemClock.uptimeMillis();
                        initialX = placement.x; initialY = placement.y;
                        moved = false;
                        initiated = !recording && !processing && !connecting;
                        if (initiated) start(failure != null && capturedBytes > 0);
                        return true;
                    }
                    case MotionEvent.ACTION_MOVE -> {
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (Math.abs(dx) + Math.abs(dy) > dp(12)) {
                            if (!moved && initiated) cancel();
                            moved = true;
                            placement.x = initialX + (int) dx; placement.y = initialY + (int) dy;
                            windows.updateViewLayout(bubble, placement);
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        if (moved) {
                            int width = getResources().getDisplayMetrics().widthPixels;
                            placement.x = placement.x + bubble.getWidth() / 2 < width / 2 ? 0 : width - bubble.getWidth();
                            windows.updateViewLayout(bubble, placement);
                        } else if (initiated && event.getActionMasked() == MotionEvent.ACTION_CANCEL) cancel();
                        else if (initiated && android.os.SystemClock.uptimeMillis() - downAt >= 320 && recording) finish();
                        return true;
                    }
                }
                return false;
            }
        });
        done.setOnClickListener(view -> {
            if (recording) finish();
            else if (clipboardReady && target != null && eligible(target)
                && target.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
                clipboardReady = false; failure = null; render();
            }
        });
        cancel.setOnClickListener(view -> cancel());
        placement = new WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        placement.gravity = Gravity.TOP | Gravity.LEFT;
        placement.x = getResources().getDisplayMetrics().widthPixels - dp(55);
        placement.y = getResources().getDisplayMetrics().heightPixels / 2;
        windows.addView(bubble, placement);
        render();
    }

    private void hide() {
        if (bubble == null) return;
        windows.removeView(bubble);
        bubble = null;
        target = null;
        windowId = -1;
    }

    private void render() {
        if (bubble == null) return;
        done.setVisibility(recording || clipboardReady ? View.VISIBLE : View.GONE);
        done.setText(clipboardReady ? "Paste" : "✓");
        cancel.setVisibility(recording || processing || connecting || failure != null ? View.VISIBLE : View.GONE);
        status.setVisibility(recording || processing || connecting || failure != null ? View.VISIBLE : View.GONE);
        status.setText(recording ? waveform + " " + partialText : processing ? "Finishing…" : connecting ? "Connecting…"
            : failure != null ? failure + " · Tap ✦ to retry" : "");
        trigger.setContentDescription(failure != null ? "Retry Pi Stack Write" : "Start Pi Stack Write dictation");
        done.setContentDescription(clipboardReady ? "Paste copied dictation" : "Done, insert dictated text");
        cancel.setContentDescription("Cancel dictation");
        bubble.post(() -> {
            if (bubble == null || placement == null || !bubble.isAttachedToWindow()) return;
            int right = getResources().getDisplayMetrics().widthPixels - bubble.getWidth();
            if (placement.x > right) { placement.x = Math.max(0, right); windows.updateViewLayout(bubble, placement); }
        });
    }

    private void start(boolean retry) {
        RemoteSession.Identity identity = NotificationIdentity.get(this).current();
        if (identity == null || target == null || !eligible(target)) { failure = "Select an editable field"; render(); return; }
        if (!retry) { synchronized (captured) { captured.clear(); capturedBytes = 0; } }
        failure = null;
        partialText = "";
        waveform = "▁▁▁▁▁▁▁▁";
        clipboardReady = false;
        long attempt = ++generation;
        connecting = true;
        replaying = retry;
        pendingFinish = false;
        streamReady = false;
        render();
        if (connection != null) connection.cancel();
        CharSequence field = target.getText();
        int cursor = target.getTextSelectionStart();
        String text = field == null ? "" : field.toString();
        int contextEnd = Math.max(0, Math.min(text.length(), cursor < 0 ? text.length() : cursor));
        String context = text.substring(Math.max(0, contextEnd - 200), contextEnd);
        connection = new WriteConnection(this, identity, new WriteConnection.Events() {
            @Override public void connected() { main.post(() -> {
                if (attempt != generation || !connecting || !NotificationIdentity.get(WriteAccessibilityService.this).isCurrent(identity)) return;
                connecting = false;
                synchronized (captured) {
                    for (byte[] chunk : captured) if (!connection.audio(chunk, chunk.length)) {
                        failed("Connection dropped during dictation"); return;
                    }
                    streamReady = true;
                }
                if (replaying || pendingFinish) {
                    processing = true;
                    connection.finish();
                }
                render();
            }); }
            @Override public void partial(String text) { main.post(() -> {
                if (attempt == generation && recording && status != null) {
                    partialText = text;
                    render();
                }
            }); }
            @Override public void finished(String text) { main.post(() -> { if (attempt == generation) completed(text); }); }
            @Override public void failed(String error) { main.post(() -> {
                if (attempt == generation) WriteAccessibilityService.this.failed(error);
            }); }
        });
        if (!retry) startRecorder();
        if (connecting) connection.connect(context);
    }

    private void startRecorder() {
        int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            failed("Microphone unavailable"); return;
        }
        try {
            Notification foreground = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Pi Stack Write is listening").setOngoing(true).build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, foreground, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION, foreground);
            recorder = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 3200));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) { failed("Microphone unavailable"); return; }
            recorder.startRecording();
            recording = true;
            AudioRecord active = recorder;
            WriteConnection stream = connection;
            recorderThread = new Thread(() -> {
                byte[] buffer = new byte[640];
                while (recording && recorder == active) {
                    int size;
                    try { size = active.read(buffer, 0, buffer.length); }
                    catch (IllegalStateException stopped) { if (recording) main.post(() -> failed("Microphone read failed")); break; }
                    if (size <= 0) { if (recording) main.post(() -> failed("Microphone read failed")); break; }
                    byte[] chunk = java.util.Arrays.copyOf(buffer, size);
                    long now = android.os.SystemClock.uptimeMillis();
                    if (now - lastWave > 80) {
                        lastWave = now;
                        long energy = 0;
                        for (int i = 0; i + 1 < size; i += 2) {
                            int sample = (short) ((chunk[i] & 0xff) | (chunk[i + 1] << 8));
                            energy += Math.abs(sample);
                        }
                        int level = Math.min(7, (int) (energy / Math.max(1, size / 2) / 1400));
                        main.post(() -> {
                            if (!recording) return;
                            waveform = waveform.substring(1) + "▁▂▃▄▅▆▇█".charAt(level);
                            render();
                        });
                    }
                    synchronized (captured) {
                        if (capturedBytes + size > 16_000 * 2 * 120) {
                            main.post(() -> failed("Two-minute recording limit; tap ✦ to retry")); break;
                        }
                        captured.add(chunk); capturedBytes += size;
                        if (streamReady && !stream.audio(chunk, size)) {
                            main.post(() -> failed("Write server disconnected; tap ✦ to retry")); break;
                        }
                    }
                }
            }, "write-audio");
            recorderThread.start();
        } catch (RuntimeException error) { failed("Could not start microphone: " + error.getMessage()); }
    }

    private void stopRecorder() {
        recording = false;
        AudioRecord active = recorder;
        recorder = null;
        if (active != null) {
            try { active.stop(); } catch (IllegalStateException ignored) { }
            active.release();
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
    }
    private void finish() {
        stopRecorder();
        processing = true;
        if (streamReady) connection.finish(); else pendingFinish = true;
        render();
    }
    private void cancel() {
        stopRecorder();
        if (connection != null) connection.cancel();
        connection = null;
        ++generation;
        connecting = false; processing = false; replaying = false; pendingFinish = false; streamReady = false;
        clipboardReady = false; failure = null;
        synchronized (captured) { captured.clear(); capturedBytes = 0; }
        render(); refresh();
    }
    private void failed(String error) {
        if (!recording && !processing && !connecting) return;
        stopRecorder();
        if (connection != null) connection.cancel();
        connecting = false; processing = false; streamReady = false; failure = error;
        render();
    }

    private void completed(String text) {
        if (!processing && !recording) return;
        stopRecorder();
        processing = false;
        connecting = false;
        if (text == null || text.isBlank()) { failure = "No speech recognized"; render(); return; }
        AccessibilityNodeInfo node = target;
        if (node == null || !eligible(node) || node.getWindowId() != windowId) {
            fallback(text); return;
        }
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
            captured.clear(); capturedBytes = 0;
            failure = null;
            render(); refresh();
        } else fallback(text);
    }

    private void fallback(String text) {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Pi Stack Write", text));
        clipboardReady = true;
        failure = "Copied to clipboard";
        captured.clear(); capturedBytes = 0;
        render();
    }

    @Override public void onInterrupt() { cancel(); hide(); }
    @Override public void onDestroy() { cancel(); hide(); super.onDestroy(); }
}

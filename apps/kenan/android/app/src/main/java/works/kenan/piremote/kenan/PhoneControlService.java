package works.kenan.piremote.kenan;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

public final class PhoneControlService extends Service {
    private static final String CHANNEL = "phone-control";
    private static final int NOTICE = 7201;
    private static volatile PhoneControlService current;
    private static volatile String errorCode = "";
    private static volatile String errorMessage = "";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService network = Executors.newSingleThreadScheduledExecutor();
    private volatile ExecutorService data = Executors.newSingleThreadExecutor();
    private final LinkedHashMap<String, JSONObject> commands = new LinkedHashMap<>();
    private volatile PhoneConnection connection;
    private RemoteSession.Identity identity;
    private volatile boolean connected;
    private volatile boolean stopping;
    private String environment;
    private int attempts;
    private boolean refreshScheduled;
    private String displayedNotice;
    private boolean displayedOverlay;
    private final android.content.BroadcastReceiver capabilitiesChanged = new android.content.BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refresh(); }
    };

    static SharedPreferences settings(Context context) { return context.getSharedPreferences("phone-control", MODE_PRIVATE); }
    static boolean enabled(Context context) {
        RemoteSession.Identity identity = NotificationIdentity.get(context).current();
        SharedPreferences prefs = settings(context);
        return PermissionSetup.complete(context) && identity != null && prefs.getBoolean("enabled", false) && identity.user.equals(prefs.getString("user", ""))
            && !prefs.getString("environment", "").isBlank();
    }
    static void start(Context context) {
        if (!enabled(context)) return;
        try { ContextCompat.startForegroundService(context, new Intent(context, PhoneControlService.class)); }
        catch (RuntimeException failure) { errorCode = "start_restricted"; errorMessage = "Open Kenan to start phone control: " + failure.getMessage(); }
    }
    static void disable(Context context) {
        synchronized (NotificationIdentity.get(context)) {
            settings(context).edit().putBoolean("enabled", false).remove("user").remove("environment").apply();
            PhoneControlService active = current;
            if (active != null) active.close();
            PhoneAccessibilityService.invalidate();
            context.stopService(new Intent(context, PhoneControlService.class));
            errorCode = ""; errorMessage = "";
        }
    }
    static void sessionChanged(Context context) {
        // Consent belongs to the owner, while every live operation belongs to one exact session.
        PhoneAccessibilityService.invalidate();
        PhoneControlService active = current;
        if (active == null) { start(context); return; }
        PhoneConnection previous = active.connection;
        active.connection = null; active.connected = false;
        if (previous != null) previous.close();
        active.data.shutdownNow(); active.data = Executors.newSingleThreadExecutor();
        active.main.post(() -> {
            for (String id : active.commands.keySet()) active.commands.put(id, null);
            if (enabled(context) && !active.stopping) active.onStartCommand(null, 0, 0);
            else active.stopSelf();
        });
    }
    static void refresh() { PhoneControlService active = current; if (active != null) active.main.post(() -> {
        if (!PermissionSetup.complete(active)) {
            active.close();
            PhoneAccessibilityService.invalidate();
            active.stopSelf();
            return;
        }
        PhoneConnection source = active.connection;
        if (!active.stopping && active.connected && source != null && !active.network.isShutdown()) active.network.execute(() -> {
            if (source == active.connection && source.valid()) source.announceChanges();
        });
        active.updateNotice(active.connected ? "Phone control connected" : errorMessage.isEmpty() ? "Connecting through Pi Remote" : errorMessage);
    }); }
    static boolean sendOverlay(JSONObject frame) {
        PhoneControlService active = current;
        PhoneConnection source = active == null ? null : active.connection;
        return active != null && active.connected && active.authorized() && source != null && source.send(frame);
    }
    static JSONObject status(Context context) {
        try {
            SharedPreferences prefs = settings(context);
            return new JSONObject().put("enabled", enabled(context)).put("overlay", KenanOverlay.isVisible(context)).put("connected", current != null && current.connected && enabled(context))
                .put("deviceId", deviceId(context)).put("name", prefs.getString("name", Build.MODEL))
                .put("environment", prefs.getString("environment", ""))
                .put("error", errorCode.isEmpty() ? JSONObject.NULL : new JSONObject().put("code", errorCode).put("message", errorMessage))
                .put("capabilities", capabilities(context)).put("setup", PermissionSetup.wire(PermissionSetup.state(context)));
        } catch (Exception defect) { throw new IllegalStateException(defect); }
    }
    static synchronized String deviceId(Context context) {
        SharedPreferences prefs = settings(context);
        String id = prefs.getString("deviceId", "");
        if (id.isEmpty()) { id = UUID.randomUUID().toString(); prefs.edit().putString("deviceId", id).apply(); }
        return id;
    }
    static JSONObject device(Context context) throws Exception {
        return new JSONObject().put("id", deviceId(context)).put("name", settings(context).getString("name", Build.MODEL))
            .put("model", Build.MODEL).put("android", Build.VERSION.RELEASE).put("capabilities", capabilities(context));
    }
    static JSONObject capabilities(Context context) {
        try {
            JSONObject caps = PhoneData.capabilities(context);
            boolean accessibility = PhoneAccessibilityService.current != null && NativeAccess.accessibility(context, PhoneAccessibilityService.class);
            caps.put("accessibility", accessibility)
                .put("screenshots", accessibility && Build.VERSION.SDK_INT >= 30)
                .put("notificationAccess", androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.getPackageName()))
                .put("notificationListenerConnected", PhoneNotificationService.current != null)
                .put("notifications", NativeAccess.notifications(context))
                .put("battery", ((PowerManager) context.getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(context.getPackageName()))
                .put("overlay", android.provider.Settings.canDrawOverlays(context))
                .put("overlayEnabled", KenanOverlay.isVisible(context))
                .put("installPackages", Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls())
                .put("camera", ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                .put("microphone", ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                .put("cameraCapture", false).put("microphoneCapture", false).put("clipboardRead", false)
                .put("deviceLocked", ((android.app.KeyguardManager) context.getSystemService(KEYGUARD_SERVICE)).isDeviceLocked())
                .put("transport", "outbound-websocket").put("requiresAdb", false).put("requiresWifi", false);
            return caps;
        } catch (Exception defect) { throw new IllegalStateException(defect); }
    }
    @Override public void onCreate() {
        super.onCreate(); current = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Phone control", NotificationManager.IMPORTANCE_LOW));
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTICE, notification("Connecting through Pi Remote"), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTICE, notification("Connecting through Pi Remote"));
        displayedNotice = "Connecting through Pi Remote";
        displayedOverlay = KenanOverlay.isVisible(this);
        android.content.IntentFilter changes = new android.content.IntentFilter();
        changes.addAction(Intent.ACTION_SCREEN_ON);
        changes.addAction(Intent.ACTION_SCREEN_OFF);
        changes.addAction(Intent.ACTION_USER_PRESENT);
        changes.addAction(Intent.ACTION_USER_UNLOCKED);
        ContextCompat.registerReceiver(this, capabilitiesChanged, changes, ContextCompat.RECEIVER_NOT_EXPORTED);
        try {
            JSONArray saved = new JSONArray(settings(this).getString("seenCommands", "[]"));
            for (int i = 0; i < saved.length(); i++) commands.put(saved.getString(i), null);
        } catch (Exception corrupt) {
            disable(this); errorCode = "state_error"; errorMessage = "Command replay ledger is invalid";
        }
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String wire = intent == null || intent.getAction() == null ? "start" : intent.getAction();
        var requested = NativeState.parse(NativeState.ServiceIntent.class, wire);
        if (requested.isEmpty()) { errorCode = "invalid_args"; errorMessage = "Unknown phone service action: " + wire; stopSelf(); return START_NOT_STICKY; }
        boolean resume = switch (requested.get()) {
            case START -> true;
            case DISABLE -> { disable(this); yield false; }
            case OVERLAY -> { KenanOverlay.setVisible(this, !KenanOverlay.isVisible(this)); yield true; }
        };
        if (!resume) return START_NOT_STICKY;
        if (stopping || !enabled(this)) { stopSelf(); return START_NOT_STICKY; }
        RemoteSession.Identity selected = NotificationIdentity.get(this).current();
        String chosen = settings(this).getString("environment", "");
        if (identity != selected || !chosen.equals(environment)) {
            if (connection != null) connection.close();
            data.shutdownNow(); data = Executors.newSingleThreadExecutor();
            identity = selected; environment = chosen; attempts = 0; connected = false;
            connect();
            if (!refreshScheduled) {
                refreshScheduled = true;
                network.scheduleWithFixedDelay(() -> {
                    PhoneConnection active = connection;
                    if (connected && active != null && active.valid()) active.heartbeat();
                }, PhoneConnection.HEARTBEAT_SECONDS, PhoneConnection.HEARTBEAT_SECONDS, TimeUnit.SECONDS);
            }
        }
        refresh();
        return START_STICKY;
    }
    private boolean authorized() { return !stopping && enabled(this) && NotificationIdentity.get(this).isCurrent(identity)
        && environment.equals(settings(this).getString("environment", "")); }
    private void connect() {
        if (!authorized()) return;
        final PhoneConnection candidate = new PhoneConnection(this, identity, environment, this::authorized, new PhoneConnection.Events() {
            public void opened(PhoneConnection source) { main.post(() -> { if (source != connection || !source.valid()) return; connected = true; attempts = 0; errorCode = ""; errorMessage = ""; updateNotice("Phone control connected"); }); }
            public void command(PhoneConnection source, JSONObject frame) { main.post(() -> receive(source, frame)); }
            public void overlayAck(PhoneConnection source, JSONObject frame) { main.post(() -> {
                PhoneAccessibilityService service = PhoneAccessibilityService.current;
                if (source == connection && source.valid() && authorized() && service != null) service.overlayAck(frame);
            }); }
            public void closed(PhoneConnection source, NativeState.PhoneFailure code, String message) { main.post(() -> { if (source == connection) lost(code, message); }); }
        });
        connection = candidate;
        network.execute(candidate::connect);
    }
    private void lost(NativeState.PhoneFailure code, String message) {
        if (!authorized()) return;
        connected = false; errorCode = code.wire(); errorMessage = message; updateNotice(message);
        PhoneAccessibilityService service = PhoneAccessibilityService.current;
        if (service != null) service.overlayDisconnected();
        Runnable recover = switch (code) {
            case SESSION_EXPIRED -> () -> NotificationIdentity.replace(this, "", "");
            case PUBLIC_SIGN_IN_REQUIRED, PERMISSION_DENIED, DISCONNECTED, PROTOCOL_ERROR, INTERNAL_ERROR -> () -> {
                long delay = Math.min(60, 1L << Math.min(6, attempts++));
                PhoneConnection previous = connection;
                network.schedule(() -> main.post(() -> { if (previous == connection && authorized()) connect(); }), delay, TimeUnit.SECONDS);
            };
        };
        recover.run();
    }
    private void receive(PhoneConnection source, JSONObject frame) {
        if (source != connection || !source.valid() || !authorized()) return;
        String id = frame.optString("id", "");
        if (id.isBlank() || id.length() > 256) { source.close(); lost(NativeState.PhoneFailure.PROTOCOL_ERROR, "Invalid command identity"); return; }
        long deadline = frame.optLong("deadline", 0);
        if (deadline <= System.currentTimeMillis()) { source.send(PhoneResult.error("expired", "Command deadline has passed").envelope(id)); return; }
        if (commands.containsKey(id)) {
            JSONObject cached = commands.get(id);
            source.send(cached == null ? PhoneResult.error("unconfirmed", "Command was already accepted; it will not be replayed").envelope(id) : cached); return;
        }
        commands.put(id, null);
        while (commands.size() > 512) commands.remove(commands.keySet().iterator().next());
        PhoneCommandReplay.accept(this, id, acceptance -> main.post(() -> {
            if (source != connection || !source.valid() || !authorized()) return;
            switch (acceptance) {
                case PERSISTED -> dispatchAccepted(source, frame, id, deadline);
                case DUPLICATE -> source.send(PhoneResult.error("unconfirmed", "Command was already accepted; it will not be replayed").envelope(id));
                case STATE_ERROR -> source.send(PhoneResult.error("state_error", "Could not persist command replay ledger").envelope(id));
                case BUSY -> source.send(PhoneResult.error("rate_limited", "Command acceptance queue is full").envelope(id));
            }
        }));
    }
    private void dispatchAccepted(PhoneConnection source, JSONObject frame, String id, long deadline) {
        String command = frame.optString("command", "");
        JSONObject args = frame.optJSONObject("args");
        if (args == null) args = new JSONObject();
        final java.util.concurrent.atomic.AtomicBoolean completed = new java.util.concurrent.atomic.AtomicBoolean();
        Consumer<PhoneResult> done = result -> main.post(() -> {
            if (!completed.compareAndSet(false, true)) return;
            JSONObject envelope = result.envelope(id);
            if (source == connection && source.valid() && authorized()) {
                if (commands.containsKey(id)) commands.put(id, envelope.toString().length() <= 16384 ? envelope : null);
                if (System.currentTimeMillis() <= deadline) source.send(envelope);
                if (result.ok && (command.equals("permissions.grant") || command.equals("settings.put"))) refresh();
            }
        });
        Runnable execute = () -> {
            RemoteSession state = NotificationIdentity.get(this);
            synchronized (state) {
                if (!authorized() || source != connection || !source.valid()) { done.accept(PhoneResult.error("disconnected", "Phone control was disabled or its session changed")); return; }
                if (System.currentTimeMillis() >= deadline) { done.accept(PhoneResult.error("expired", "Command deadline has passed")); return; }
                JSONObject coreArgs = frame.optJSONObject("args") == null ? new JSONObject() : frame.optJSONObject("args");
                if ((command.equals("ui.tap") || command.equals("ui.swipe"))
                    && coreArgs.optLong("durationMs", command.equals("ui.tap") ? 50 : 300) + System.currentTimeMillis() >= deadline) {
                    done.accept(PhoneResult.error("expired", "Gesture cannot finish before the command deadline")); return;
                }
                dispatch(command, coreArgs, deadline, () -> authorized() && source == connection && source.valid(), done);
            }
        };
        if (PhoneData.supports(command)) {
            final JSONObject dataArgs = args;
            try { data.execute(() -> {
                if (!authorized() || source != connection || !source.valid() || System.currentTimeMillis() >= deadline) {
                    done.accept(PhoneResult.error("expired", "Command authorization or deadline expired")); return;
                }
                JSONObject result = PhoneData.dispatch(this, command, dataArgs, deadline,
                    () -> authorized() && source == connection && source.valid() && System.currentTimeMillis() < deadline);
                done.accept(result.optBoolean("ok") ? PhoneResult.success(result.opt("result"))
                    : PhoneResult.error(result.optJSONObject("error").optString("code"), result.optJSONObject("error").optString("message")));
            }); } catch (java.util.concurrent.RejectedExecutionException stopped) {
                done.accept(PhoneResult.error("disconnected", "Phone control session changed"));
            }
        } else execute.run();
    }
    private void dispatch(String command, JSONObject args, long deadline, java.util.function.BooleanSupplier authorized, Consumer<PhoneResult> done) {
        try {
            if (command.equals("overlay.say") && args.has("receiptId")) {
                RemoteSession.Identity owner = NotificationIdentity.get(this).current();
                if (owner == null) { done.accept(PhoneResult.error("session_expired", "Reply owner is not authenticated")); return; }
                String text = args.optString("text");
                long duration = args.optLong("durationMs", Math.min(20000, 3000 + 50L * text.length()));
                if (duration < 0) { done.accept(PhoneResult.error("invalid_args", "durationMs must be nonnegative")); return; }
                OverlayReplyReceipts.deliver(this, owner.user, args, deadline, authorized, (drawn, failed) -> {
                    PhoneAccessibilityService service = PhoneAccessibilityService.current;
                    if (service == null) failed.accept(PhoneResult.error("not_displayed", "Phone accessibility service is unavailable"));
                    else service.presentReply(text, duration, deadline, authorized, drawn, failed);
                }, done);
                return;
            }
            if (NativeState.parse(NativeState.AccessibilityCommand.class, command).isPresent()
                || NativeState.parse(NativeState.OverlayCommand.class, command).isPresent()) {
                PhoneAccessibilityService service = PhoneAccessibilityService.current;
                if (service == null) done.accept(PhoneResult.error("permission_denied", "Enable the Phone control accessibility service on the phone"));
                else service.dispatch(command, args, deadline, authorized, done);
                return;
            }
            if (NativeState.parse(NativeState.NotificationCommand.class, command).isPresent()) {
                PhoneNotificationService listener = PhoneNotificationService.current;
                if (listener == null) done.accept(PhoneResult.error("permission_denied", "Enable Phone control notification access on the phone"));
                else listener.dispatch(command, args, done);
                return;
            }
            var parsed = NativeState.parse(NativeState.ServiceCommand.class, command);
            if (parsed.isEmpty()) { done.accept(PhoneResult.error("unsupported", "Unknown phone command: " + command)); return; }
            NativeState.Action action = switch (parsed.get()) {
                case STATUS -> () -> done.accept(PhoneResult.success(status(this)));
                case APP_LAUNCH -> () -> {
                    Intent launch = getPackageManager().getLaunchIntentForPackage(args.getString("package"));
                    if (launch == null) { done.accept(PhoneResult.error("not_found", "No launchable activity for this package")); return; }
                    startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    done.accept(PhoneResult.success(new JSONObject().put("requested", true)));
                };
                case URL_OPEN -> () -> {
                    Uri uri = Uri.parse(args.getString("url"));
                    if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) { done.accept(PhoneResult.error("invalid_args", "URL must use http or https")); return; }
                    startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    done.accept(PhoneResult.success(new JSONObject().put("requested", true)));
                };
                case CLIPBOARD_SET -> () -> {
                    String text = args.getString("text");
                    if (text.length() > 100000) { done.accept(PhoneResult.error("invalid_args", "Clipboard text exceeds 100000 characters")); return; }
                    ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Pi Remote", text));
                    done.accept(PhoneResult.success(new JSONObject()));
                };
            };
            action.run();
        } catch (SecurityException failure) { done.accept(PhoneResult.error("permission_denied", failure.getMessage())); }
        catch (android.content.ActivityNotFoundException failure) { done.accept(PhoneResult.error("not_found", "No application can open this request")); }
        catch (Exception failure) { done.accept(PhoneResult.error("invalid_args", failure.getMessage())); }
    }
    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent activity = PendingIntent.getActivity(this, NOTICE, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent disable = PendingIntent.getService(this, NOTICE, new Intent(this, PhoneControlService.class).setAction("disable"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent overlay = PendingIntent.getService(this, NOTICE + 1, new Intent(this, PhoneControlService.class).setAction("overlay"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Kenan phone control").setContentText(text).setOngoing(true).setContentIntent(activity)
            .addAction(0, KenanOverlay.isVisible(this) ? "Hide Kenan" : "Show Kenan", overlay)
            .addAction(0, "Disable", disable).build();
    }
    private void updateNotice(String text) {
        boolean overlay = KenanOverlay.isVisible(this);
        if (text.equals(displayedNotice) && overlay == displayedOverlay) return;
        getSystemService(NotificationManager.class).notify(NOTICE, notification(text));
        displayedNotice = text;
        displayedOverlay = overlay;
    }
    private void close() { stopping = true; connected = false; PhoneConnection active = connection; connection = null; if (active != null) active.close(); network.shutdownNow(); data.shutdownNow(); main.removeCallbacksAndMessages(null); }
    @Override public void onDestroy() { unregisterReceiver(capabilitiesChanged); close(); if (current == this) current = null; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}

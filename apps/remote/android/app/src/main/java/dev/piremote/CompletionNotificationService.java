package dev.piremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CompletionNotificationService extends Service {
    static final String EXTRA_SESSION_ID = "dev.piremote.SESSION_ID";
    private static final String ACTION_WATCH = "dev.piremote.WATCH_COMPLETION";
    private static final String ACTION_UNWATCH = "dev.piremote.UNWATCH_COMPLETION";
    private static final String EXTRA_IDS = "session_ids";
    private static final String EXTRA_NAMES = "session_names";
    private static final String PREFS = "completion_notifications";
    private static final String PREF_WATCHED = "watched";
    private static final String PREF_APP_VISIBLE = "app_visible";
    private static final String PREF_OPEN_SESSION = "open_session";
    private static final String PREF_VISIBILITY_HEARTBEAT = "visibility_heartbeat";
    private static final String MONITOR_CHANNEL = "thread_monitor";
    private static final String COMPLETION_CHANNEL = "thread_completions";
    private static final int MONITOR_NOTIFICATION_ID = 1001;
    private static final long POLL_INTERVAL_MS = 2_500;
    private static final long ERROR_INTERVAL_MS = 10_000;

    private final CompletionTracker tracker = new CompletionTracker();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean polling;
    private boolean foreground;
    private String lastMonitorText = "";
    private final Runnable poller = this::poll;

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel monitor = new NotificationChannel(
            MONITOR_CHANNEL, "Active thread monitoring", NotificationManager.IMPORTANCE_LOW);
        monitor.setDescription("Keeps completion monitoring active while Pi is working");
        monitor.setSound(null, null);
        monitor.enableVibration(false);
        monitor.setShowBadge(false);
        NotificationChannel completions = new NotificationChannel(
            COMPLETION_CHANNEL, "Thread completions", NotificationManager.IMPORTANCE_DEFAULT);
        completions.setDescription("Notifies when a Pi Remote thread finishes");
        // A thread finishing is the one moment worth feeling from a pocket, so this channel
        // keeps a short two-beat pattern instead of the platform's single default buzz.
        completions.enableVibration(true);
        completions.setVibrationPattern(new long[]{ 0, 35, 90, 55 });
        manager.createNotificationChannel(monitor);
        manager.createNotificationChannel(completions);
    }

    static boolean watchSessions(Context context, Collection<String> ids, Collection<String> names) {
        if (ids == null || ids.isEmpty()) return true;
        Intent intent = new Intent(context, CompletionNotificationService.class).setAction(ACTION_WATCH);
        intent.putStringArrayListExtra(EXTRA_IDS, new ArrayList<>(ids));
        intent.putStringArrayListExtra(EXTRA_NAMES, new ArrayList<>(names));
        return start(context, intent, true);
    }

    static boolean watchSession(Context context, String id, String name) {
        ArrayList<String> ids = new ArrayList<>(); ids.add(id);
        ArrayList<String> names = new ArrayList<>(); names.add(name);
        return watchSessions(context, ids, names);
    }

    static void unwatchSession(Context context, String id) {
        Intent intent = new Intent(context, CompletionNotificationService.class).setAction(ACTION_UNWATCH);
        intent.putExtra(EXTRA_SESSION_ID, id);
        start(context, intent, false);
    }

    static void clearCompletionNotification(Context context, String id) {
        context.getSystemService(NotificationManager.class).cancel(completionNotificationId(id));
    }

    static void setOpenThread(Context context, String id, boolean visible) {
        String openThreadId = id == null ? "" : id;
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_APP_VISIBLE, visible)
            .putString(PREF_OPEN_SESSION, openThreadId)
            .putLong(PREF_VISIBILITY_HEARTBEAT, System.currentTimeMillis())
            .apply();
        if (visible && !openThreadId.isEmpty()) clearCompletionNotification(context, openThreadId);
    }

    private boolean isThreadOpen(String id) {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        return OpenThreadVisibility.matches(
            id,
            preferences.getBoolean(PREF_APP_VISIBLE, false),
            preferences.getString(PREF_OPEN_SESSION, ""),
            preferences.getLong(PREF_VISIBILITY_HEARTBEAT, 0),
            System.currentTimeMillis());
    }

    private static boolean start(Context context, Intent intent, boolean foreground) {
        try {
            if (foreground) context.startForegroundService(intent);
            else context.startService(intent);
            return true;
        } catch (RuntimeException ignored) {
            // Android can reject a new foreground-service start after the activity
            // has already moved to the background. The activity leaves the watch
            // unclaimed and retries it on its next authoritative session poll.
            return false;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        createChannels(this);
        restoreWatched();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_UNWATCH.equals(intent.getAction())) {
            tracker.remove(intent.getStringExtra(EXTRA_SESSION_ID));
        } else if (intent != null && ACTION_WATCH.equals(intent.getAction())) {
            ArrayList<String> ids = intent.getStringArrayListExtra(EXTRA_IDS);
            ArrayList<String> names = intent.getStringArrayListExtra(EXTRA_NAMES);
            if (ids != null) for (int i = 0; i < ids.size(); i++)
                tracker.watch(ids.get(i), names != null && i < names.size() ? names.get(i) : "Thread");
        }
        persistWatched();
        if (tracker.isEmpty()) {
            stopMonitoring();
            return START_NOT_STICKY;
        }
        ensureForeground();
        schedulePoll(0);
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public void onDestroy() {
        main.removeCallbacks(poller);
        network.shutdownNow();
        super.onDestroy();
    }

    private void ensureForeground() {
        int count = tracker.size();
        String text = count == 1
            ? "Waiting for " + tracker.watched().get(0).name
            : "Watching " + count + " active threads";
        if (!foreground) {
            startForeground(MONITOR_NOTIFICATION_ID, monitorNotification(text));
            foreground = true;
            lastMonitorText = text;
        } else if (!text.equals(lastMonitorText)) {
            getSystemService(NotificationManager.class).notify(MONITOR_NOTIFICATION_ID, monitorNotification(text));
            lastMonitorText = text;
        }
    }

    private Notification monitorNotification(String text) {
        return builder(MONITOR_CHANNEL)
            .setContentTitle("Pi Remote")
            .setContentText(text)
            .setContentIntent(openAppIntent(null))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void poll() {
        if (polling || tracker.isEmpty()) return;
        polling = true;
        List<CompletionTracker.Snapshot> watched = tracker.watched();
        network.execute(() -> {
            List<CompletionTracker.Snapshot> sessions = null;
            try { sessions = fetchSessions(watched); }
            catch (Exception ignored) {}
            List<CompletionTracker.Snapshot> result = sessions;
            main.post(() -> {
                polling = false;
                if (result == null) {
                    schedulePoll(ERROR_INTERVAL_MS);
                    return;
                }
                for (CompletionTracker.Completion completion : tracker.update(result)) notifyCompletion(completion);
                persistWatched();
                if (tracker.isEmpty()) stopMonitoring();
                else {
                    ensureForeground();
                    schedulePoll(POLL_INTERVAL_MS);
                }
            });
        });
    }

    private List<CompletionTracker.Snapshot> fetchSessions(Collection<CompletionTracker.Snapshot> watched) throws Exception {
        Set<String> watchedIds = new HashSet<>();
        for (CompletionTracker.Snapshot item : watched) watchedIds.add(item.id);
        JSONArray values = getJson("/v1/sessions").optJSONArray("sessions");
        List<CompletionTracker.Snapshot> sessions = new ArrayList<>();
        if (values != null) for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.optJSONObject(i); if (value == null) continue;
            String id = value.optString("id");
            String state = value.optString("state");
            String lastAssistantText = null;
            if (watchedIds.contains(id) && !CompletionTracker.isActive(state))
                lastAssistantText = fetchLastAssistantText(id);
            sessions.add(new CompletionTracker.Snapshot(
                id, value.optString("name", "Thread"), state, lastAssistantText));
        }
        return sessions;
    }

    private String fetchLastAssistantText(String id) {
        try {
            JSONArray events = getJson("/v1/sessions/" + id + "/events?after=0").optJSONArray("events");
            if (events == null) return null;
            for (int i = events.length() - 1; i >= 0; i--) {
                JSONObject event = events.optJSONObject(i);
                if (event == null || !"assistant".equals(event.optString("type"))) continue;
                String text = event.optString("text").trim();
                if (text.isEmpty()) continue;
                return text.length() <= 4_000 ? text : text.substring(0, 3_999) + "…";
            }
        } catch (Exception ignored) {}
        return null;
    }

    private JSONObject getJson(String path) throws Exception {
        return PiRemoteApi.get(path);
    }

    private void notifyCompletion(CompletionTracker.Completion completion) {
        if (isThreadOpen(completion.id)) {
            clearCompletionNotification(this, completion.id);
            return;
        }
        boolean failed = "FAILED".equals(completion.state);
        String assistantText = completion.lastAssistantText == null ? "" : completion.lastAssistantText.trim();
        String text = !failed && !assistantText.isEmpty()
            ? assistantText
            : completion.name + (failed ? " needs attention." : " has finished.");
        Notification notification = builder(COMPLETION_CHANNEL)
            .setContentTitle(completion.name)
            .setSubText(failed ? "Thread failed" : "Thread complete")
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(openAppIntent(completion.id))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build();
        getSystemService(NotificationManager.class).notify(completionNotificationId(completion.id), notification);
    }

    private Notification.Builder builder(String channel) {
        return new Notification.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xff89b4fa)
            .setShowWhen(true);
    }

    private PendingIntent openAppIntent(String sessionId) {
        Intent intent = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null) intent.putExtra(EXTRA_SESSION_ID, sessionId);
        int requestCode = sessionId == null ? 0 : completionNotificationId(sessionId);
        return PendingIntent.getActivity(this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static int completionNotificationId(String id) {
        return 10_000 + (id == null ? 0 : id.hashCode() & 0x3fffffff);
    }

    private void schedulePoll(long delay) {
        main.removeCallbacks(poller);
        main.postDelayed(poller, delay);
    }

    private void stopMonitoring() {
        main.removeCallbacks(poller);
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
            lastMonitorText = "";
        }
        stopSelf();
    }

    private void restoreWatched() {
        String encoded = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_WATCHED, "[]");
        try {
            JSONArray values = new JSONArray(encoded);
            for (int i = 0; i < values.length(); i++) {
                JSONObject value = values.optJSONObject(i); if (value == null) continue;
                tracker.watch(value.optString("id"), value.optString("name", "Thread"));
            }
        } catch (Exception ignored) {}
    }

    private void persistWatched() {
        JSONArray values = new JSONArray();
        try {
            for (CompletionTracker.Snapshot item : tracker.watched())
                values.put(new JSONObject().put("id", item.id).put("name", item.name));
        } catch (Exception ignored) {}
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        preferences.edit().putString(PREF_WATCHED, values.toString()).apply();
    }
}

package works.kenan.piremote.kenan;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class IdleNotificationService extends Service {
    private static final String WATCHING = "session-monitor";
    private static final String IDLE = "session-idle";
    /** The foreground web client streams the selected environment's notifications itself; this
     * service covers the background and the other environments, where half a minute is soon enough. */
    private static final long POLL_SECONDS = 30;
    /** Permitted environments change rarely; discovery is refreshed on this interval, or after a failure. */
    private static final long DISCOVERY_MS = 5 * 60 * 1000;
    private ScheduledExecutorService executor;
    private List<RemoteEnvironment.Endpoint> discovered;
    private long discoveredAt;
    private SharedPreferences preferences;
    private NotificationManager notifications;
    private RemoteSession state;
    private RemoteSession.Identity watching;
    private boolean active = true;
    private String detail = "Discovering permitted environments";

    @Override public void onCreate() {
        preferences = getSharedPreferences("idle-notifications", MODE_PRIVATE);
        state = NotificationIdentity.get(this);
        notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(WATCHING, "Session monitoring", NotificationManager.IMPORTANCE_LOW));
        notifications.createNotificationChannel(new NotificationChannel(IDLE, "Session idle", NotificationManager.IMPORTANCE_HIGH));
        startForeground(1, monitoringNotification());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        synchronized (state) {
            RemoteSession.Identity identity = state.current();
            if (identity == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (executor != null && watching == identity) return START_STICKY;
            if (executor != null) executor.shutdownNow();
            watching = identity;
            discovered = null;
            detail = "Discovering permitted environments";
            notifications.notify(1, monitoringNotification());
            executor = Executors.newSingleThreadScheduledExecutor();
            executor.scheduleWithFixedDelay(() -> poll(identity), 0, POLL_SECONDS, TimeUnit.SECONDS);
            return START_STICKY;
        }
    }

    private boolean current(RemoteSession.Identity identity) {
        return active && state.isCurrent(identity) && !Thread.currentThread().isInterrupted();
    }

    private void poll(RemoteSession.Identity identity) {
        List<RemoteEnvironment.Endpoint> endpoints;
        try {
            synchronized (state) {
                if (!current(identity)) return;
                endpoints = discovered != null && System.currentTimeMillis() - discoveredAt < DISCOVERY_MS ? discovered : null;
            }
            if (endpoints == null) endpoints = RemoteEnvironment.parse(BuildConfig.ROUTER_URL,
                RemoteTransport.get(BuildConfig.ROUTER_URL + "/v1/environments", identity));
            synchronized (state) {
                if (!current(identity)) return;
                discovered = endpoints;
                discoveredAt = System.currentTimeMillis();
                Set<String> ids = new HashSet<>();
                for (RemoteEnvironment.Endpoint endpoint : endpoints) ids.add(endpoint.id);
                SharedPreferences.Editor edit = preferences.edit();
                boolean removed = false;
                for (String id : preferences.getAll().keySet()) if (!ids.contains(id)) {
                    edit.remove(id);
                    removed = true;
                }
                if (removed) {
                    edit.apply();
                    ThreadNotifications.clear(this);
                }
                detail = endpoints.isEmpty() ? "No permitted environments" : "Monitoring permitted environments";
            }
        } catch (RemoteTransport.AccessDenied failure) {
            synchronized (state) {
                if (!current(identity)) return;
                NotificationIdentity.replace(this, "", "");
                stopSelf();
            }
            return;
        } catch (Exception failure) {
            synchronized (state) { discovered = null; }
            report(identity, "Discovery failed: " + failure.getMessage());
            return;
        }
        for (RemoteEnvironment.Endpoint endpoint : endpoints) {
            try { pollEndpoint(endpoint, identity); }
            catch (Exception failure) { report(identity, endpoint.name + ": " + failure.getMessage()); }
        }
        synchronized (state) {
            if (current(identity)) notifications.notify(1, monitoringNotification());
        }
    }

    private void pollEndpoint(RemoteEnvironment.Endpoint endpoint, RemoteSession.Identity identity) throws Exception {
        String query;
        synchronized (state) {
            if (!current(identity)) return;
            query = preferences.contains(endpoint.id) ? "?after=" + preferences.getLong(endpoint.id, 0) : "";
        }
        JSONObject feed = RemoteTransport.get(endpoint.baseUrl + "/v1/notifications" + query, identity);
        if (!endpoint.id.equals(feed.getString("environmentId"))) throw new java.io.IOException("Environment identity mismatch");
        JSONArray events = feed.getJSONArray("notifications");
        synchronized (state) {
            if (!current(identity)) return;
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index);
                String thread = ThreadNotifications.key(identity.user, endpoint.id, event.getString("sessionId"));
                Intent open = new Intent(this, MainActivity.class)
                    .setAction("idle:" + thread + ":" + event.getLong("seq"))
                    .putExtra("environment", endpoint.id).putExtra("sessionId", event.getString("sessionId")).putExtra("user", identity.user)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent target = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                ThreadNotifications.show(this, thread, new NotificationCompat.Builder(this, IDLE)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setLargeIcon(android.graphics.BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher_foreground))
                    .addExtras(ThreadNotifications.extras(thread))
                    .setContentTitle(endpoint.name + " · " + event.getString("name"))
                    .setContentText("Session is idle")
                    .setContentIntent(target).setAutoCancel(true).setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
            }
            preferences.edit().putLong(endpoint.id, feed.getLong("cursor")).apply();
        }
    }

    private void report(RemoteSession.Identity identity, String message) {
        synchronized (state) {
            if (!current(identity)) return;
            if (!detail.equals(message)) Log.w("IdleNotifications", message);
            detail = message;
            notifications.notify(1, monitoringNotification());
        }
    }

    private android.app.Notification monitoringNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, WATCHING).setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher_foreground))
            .setContentTitle("Pi Remote session notifications").setContentText(detail)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).build();
    }

    @Override public void onDestroy() {
        synchronized (state) {
            active = false;
            if (executor != null) executor.shutdownNow();
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

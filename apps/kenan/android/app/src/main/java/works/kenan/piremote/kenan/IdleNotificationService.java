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
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class IdleNotificationService extends Service {
    private static final String WATCHING = "session-monitor";
    private static final String IDLE = "session-idle";
    private final ConcurrentHashMap<String, String> status = new ConcurrentHashMap<>();
    private ScheduledExecutorService executor;
    private SharedPreferences preferences;
    private NotificationManager notifications;
    private volatile String user;

    @Override public void onCreate() {
        preferences = getSharedPreferences("idle-notifications", MODE_PRIVATE);
        notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(WATCHING, "Session monitoring", NotificationManager.IMPORTANCE_LOW));
        notifications.createNotificationChannel(new NotificationChannel(IDLE, "Session idle", NotificationManager.IMPORTANCE_HIGH));
        startForeground(1, monitoringNotification());
    }

    @Override public synchronized int onStartCommand(Intent intent, int flags, int startId) {
        String nextUser = intent == null ? preferences.getString("user", "") : intent.getStringExtra("user");
        if (nextUser == null) nextUser = "";
        if (executor != null && nextUser.equals(user)) return START_STICKY;
        if (executor != null) executor.shutdownNow();
        user = nextUser;
        preferences.edit().putString("user", user).apply();
        status.clear();
        RemoteEnvironment environments = new RemoteEnvironment(this);
        executor = Executors.newScheduledThreadPool(environments.all().size());
        String owner = user;
        for (RemoteEnvironment.Endpoint endpoint : environments.all()) {
            executor.scheduleWithFixedDelay(() -> poll(endpoint, owner), 0, 5, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    private void poll(RemoteEnvironment.Endpoint endpoint, String owner) {
        String key = owner + ":" + endpoint.id;
        HttpURLConnection connection = null;
        try {
            RemoteConnections.forEndpoint(endpoint).prepare(endpoint);
            String query = preferences.contains(key) ? "?after=" + preferences.getLong(key, 0) : "";
            connection = (HttpURLConnection) new URL(endpoint.baseUrl + "/v1/notifications" + query).openConnection();
            connection.setConnectTimeout(7_000);
            connection.setReadTimeout(7_000);
            connection.setUseCaches(false);
            if (!owner.isBlank()) connection.setRequestProperty("x-pi-remote-user", owner);
            int code = connection.getResponseCode();
            if (code != 200) throw new java.io.IOException(code == 423 ? "Locked. Open this environment to unlock." : "HTTP " + code);
            JSONObject feed;
            try (InputStream stream = connection.getInputStream()) {
                feed = new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            }
            if (!endpoint.id.equals(feed.getString("environmentId"))) throw new java.io.IOException("Environment identity mismatch");
            JSONArray events = feed.getJSONArray("notifications");
            if (!owner.equals(user) || Thread.currentThread().isInterrupted()) return;
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index);
                Intent open = new Intent(this, MainActivity.class)
                    .setAction("idle:" + key + ":" + event.getLong("seq"))
                    .putExtra("environment", endpoint.id).putExtra("sessionId", event.getString("sessionId")).putExtra("user", owner)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent target = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                notifications.notify(key + ":" + event.getLong("seq"), 2, new NotificationCompat.Builder(this, IDLE)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(endpoint.name + " · " + event.getString("name"))
                    .setContentText("Session is idle")
                    .setContentIntent(target).setAutoCancel(true).setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
            }
            if (!preferences.edit().putLong(key, feed.getLong("cursor")).commit()) throw new java.io.IOException("Could not save notification cursor");
            status.put(endpoint.id, endpoint.name + " connected");
        } catch (Exception failure) {
            if (Thread.currentThread().isInterrupted() || !owner.equals(user)) return;
            RemoteConnections.forEndpoint(endpoint).close();
            String detail = endpoint.name + ": " + failure.getMessage();
            if (!detail.equals(status.put(endpoint.id, detail))) Log.w("IdleNotifications", detail);
        } finally {
            if (connection != null) connection.disconnect();
        }
        if (owner.equals(user)) notifications.notify(1, monitoringNotification());
    }

    private android.app.Notification monitoringNotification() {
        String detail = status.isEmpty() ? "Connecting to all environments" : String.join(" · ", status.values());
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, WATCHING).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Pi Remote session notifications").setContentText(detail)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).build();
    }

    @Override public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

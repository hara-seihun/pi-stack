package works.kenan.piremote.kenan;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class IdleNotificationService extends Service {
    private static final String WATCHING = "session-monitor";
    private static final long POLL_SECONDS = 30;
    static final long DISCOVERY_MS = 5 * 60 * 1000;
    private static volatile IdleNotificationService running;
    private ScheduledExecutorService executor;
    private final AtomicBoolean pollQueued = new AtomicBoolean();
    private List<RemoteEnvironment.Endpoint> discovered;
    private String discoveredRouter;
    private long discoveredAt;
    private NotificationManager notifications;
    private android.graphics.Bitmap icon;
    private RemoteSession state;
    private RemoteSession.Identity watching;
    private boolean active = true;
    private String detail = "Discovering permitted environments";
    private String displayedDetail;

    static void requestPoll() {
        IdleNotificationService service = running;
        if (service == null) return;
        synchronized (service.state) {
            if (!service.active || service.executor == null || service.executor.isShutdown() || !service.pollQueued.compareAndSet(false, true)) return;
            RemoteSession.Identity identity = service.watching;
            service.executor.execute(() -> {
                try { service.poll(identity); }
                finally { service.pollQueued.set(false); }
            });
        }
    }

    @Override public void onCreate() {
        state = NotificationIdentity.get(this);
        running = this;
        notifications = getSystemService(NotificationManager.class);
        icon = android.graphics.BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher_foreground);
        notifications.createNotificationChannel(new NotificationChannel(WATCHING, "Session monitoring", NotificationManager.IMPORTANCE_LOW));
        notifications.createNotificationChannel(new NotificationChannel(NotificationDelivery.CHANNEL, "Agent updates and questions", NotificationManager.IMPORTANCE_HIGH));
        startForeground(1, monitoringNotification());
        displayedDetail = detail;
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
            updateNotice();
            executor = Executors.newSingleThreadScheduledExecutor();
            executor.scheduleWithFixedDelay(() -> poll(identity), 0, POLL_SECONDS, TimeUnit.SECONDS);
            return START_STICKY;
        }
    }

    private boolean current(RemoteSession.Identity identity) {
        return active && state.isCurrent(identity) && !Thread.currentThread().isInterrupted();
    }

    static boolean discoveryFresh(long now, long discoveredAt, String router, String discoveredRouter) {
        return router.equals(discoveredRouter) && now >= discoveredAt && now - discoveredAt < DISCOVERY_MS;
    }

    private void poll(RemoteSession.Identity identity) {
        List<RemoteEnvironment.Endpoint> endpoints;
        String router = RouterConnection.routerUrl();
        try {
            synchronized (state) {
                if (!current(identity)) return;
                endpoints = discovered != null && discoveryFresh(SystemClock.elapsedRealtime(), discoveredAt, router, discoveredRouter) ? discovered : null;
            }
            if (endpoints == null) {
                endpoints = RemoteEnvironment.parse(router, RemoteTransport.get(router + "/v1/environments", identity));
                synchronized (state) {
                    if (!current(identity) || !router.equals(RouterConnection.routerUrl())) return;
                    if (discoveredRouter != null && !router.equals(discoveredRouter)) NotificationFeedLease.clear();
                    if (discovered != null) for (RemoteEnvironment.Endpoint previous : discovered) {
                        for (RemoteEnvironment.Endpoint next : endpoints) if (previous.id.equals(next.id) && !previous.baseUrl.equals(next.baseUrl)) NotificationFeedLease.release(next.id);
                    }
                    discovered = endpoints;
                    discoveredRouter = router;
                    discoveredAt = SystemClock.elapsedRealtime();
                    Set<String> ids = new HashSet<>();
                    for (RemoteEnvironment.Endpoint endpoint : endpoints) ids.add(endpoint.id);
                    NotificationDelivery.retain(this, ids);
                    NotificationFeedLease.retain(ids);
                }
            }
        } catch (RemoteTransport.AccessDenied failure) {
            synchronized (state) {
                if (!current(identity) || !router.equals(RouterConnection.routerUrl())) return;
                NotificationIdentity.replace(this, "", "");
                stopSelf();
            }
            return;
        } catch (Exception failure) {
            synchronized (state) { if (current(identity)) discovered = null; }
            report(identity, "Discovery failed: " + failure.getMessage());
            return;
        }
        String failureDetail = null;
        for (RemoteEnvironment.Endpoint endpoint : endpoints) {
            try { pollEndpoint(endpoint, identity, router); }
            catch (Exception failure) {
                synchronized (state) {
                    if (!current(identity) || !router.equals(RouterConnection.routerUrl())) return;
                    discovered = null;
                    NotificationFeedLease.release(endpoint.id);
                }
                failureDetail = endpoint.name + ": " + failure.getMessage();
                if (failure instanceof RemoteTransport.AccessDenied) break;
            }
        }
        report(identity, failureDetail != null ? failureDetail : endpoints.isEmpty() ? "No permitted environments" : "Monitoring permitted environments");
    }

    private void pollEndpoint(RemoteEnvironment.Endpoint endpoint, RemoteSession.Identity identity, String router) throws Exception {
        String query;
        synchronized (state) {
            if (!current(identity) || !router.equals(RouterConnection.routerUrl()) || NotificationFeedLease.owns(identity, endpoint.id, SystemClock.elapsedRealtime())) return;
            query = NotificationDelivery.query(this, endpoint.id);
        }
        JSONObject feed = RemoteTransport.get(endpoint.baseUrl + "/v1/notifications" + query, identity);
        if (!endpoint.id.equals(feed.getString("environmentId"))) throw new java.io.IOException("Environment identity mismatch");
        synchronized (state) {
            if (!current(identity) || !router.equals(RouterConnection.routerUrl())) return;
            NotificationDelivery.receive(this, identity, endpoint.id, endpoint.name, feed, false);
        }
    }

    private void report(RemoteSession.Identity identity, String message) {
        synchronized (state) {
            if (!current(identity)) return;
            if (!detail.equals(message) && !message.equals("Monitoring permitted environments") && !message.equals("No permitted environments")) Log.w("IdleNotifications", message);
            detail = message;
            updateNotice();
        }
    }

    private void updateNotice() {
        if (detail.equals(displayedDetail)) return;
        notifications.notify(1, monitoringNotification());
        displayedDetail = detail;
    }

    private android.app.Notification monitoringNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, WATCHING).setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(icon).setContentTitle("Pi Remote session notifications").setContentText(detail)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail)).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).build();
    }

    @Override public void onDestroy() {
        synchronized (state) {
            active = false;
            NotificationFeedLease.clear();
            if (running == this) running = null;
            if (executor != null) executor.shutdownNow();
        }
        icon = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

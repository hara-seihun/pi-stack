package works.kenan.piremote.kenan;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

/** One native cursor and delivery path for polled and streamed agent notices. */
final class NotificationDelivery {
    static final String CHANNEL = "session-idle";
    private static final String CURSOR = "cursor:";
    private static final String SEEN = "seen:";

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("idle-notifications", Context.MODE_PRIVATE);
    }

    static String query(Context context, String environment) {
        SharedPreferences prefs = preferences(context);
        long cursor = cursor(prefs, environment);
        return cursor >= 0 ? "?after=" + cursor : "";
    }

    private static long cursor(SharedPreferences prefs, String environment) {
        if (prefs.contains(CURSOR + environment)) return prefs.getLong(CURSOR + environment, 0);
        if (!prefs.contains(environment)) return -1;
        long existing = prefs.getLong(environment, 0);
        prefs.edit().remove(environment).putLong(CURSOR + environment, existing).apply();
        return existing;
    }

    static void retain(Context context, Set<String> environments) {
        SharedPreferences prefs = preferences(context);
        SharedPreferences.Editor edit = prefs.edit();
        boolean removed = false;
        for (String key : prefs.getAll().keySet()) {
            if ((key.startsWith(CURSOR) && !environments.contains(key.substring(CURSOR.length())))
                || (key.startsWith(SEEN) && !environments.contains(key.substring(SEEN.length())))
                || (!key.startsWith(CURSOR) && !key.startsWith(SEEN) && !environments.contains(key))) {
                edit.remove(key);
                removed = true;
            }
        }
        if (removed) {
            edit.apply();
            ThreadNotifications.clearAlerts(context);
        }
    }

    static void receive(Context context, RemoteSession.Identity identity, String environment, String name,
                        JSONObject feed, boolean stream) throws Exception {
        RemoteSession state = NotificationIdentity.get(context);
        synchronized (state) {
            if (!state.isCurrent(identity)) return;
            SharedPreferences prefs = preferences(context);
            String cursorKey = CURSOR + environment;
            String seenKey = SEEN + environment;
            long cursor = cursor(prefs, environment);
            long next = feed.getLong("cursor");
            if (next < 0) throw new IllegalArgumentException("Invalid notification cursor");
            JSONArray previous = new JSONArray(prefs.getString(seenKey, "[]"));
            Set<Long> seen = new HashSet<>();
            for (int i = 0; i < previous.length(); i++) seen.add(previous.getLong(i));
            NotificationSequence sequence = new NotificationSequence(cursor, seen);
            JSONArray events = feed.getJSONArray("notifications");
            if (events.length() > 0) context.getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "Agent updates and questions", NotificationManager.IMPORTANCE_HIGH));
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.getJSONObject(i);
                long seq = event.getLong("seq");
                if (!sequence.accept(seq, next, stream)) continue;
                String session = event.getString("sessionId");
                String thread = ThreadNotifications.key(identity.user, environment, session);
                NativeState.NotificationKind kind = NativeState.require(NativeState.NotificationKind.class, event.getString("kind"));
                boolean question = kind == NativeState.NotificationKind.QUESTION;
                boolean alertAgain = switch (kind) {
                    case IDLE -> false;
                    case QUESTION, ATTENTION -> true;
                };
                String title = name + " · " + event.getString("name") + (question ? " · Question" : "");
                String body = event.optString("body", "Session is idle");
                Intent open = new Intent(context, MainActivity.class)
                    .setAction("idle:" + thread + ":" + seq)
                    .putExtra("environment", environment).putExtra("sessionId", session).putExtra("user", identity.user)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent target = PendingIntent.getActivity(context, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                android.app.Notification notification = new NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setLargeIcon(android.graphics.BitmapFactory.decodeResource(context.getResources(), R.mipmap.ic_launcher_foreground))
                    .addExtras(ThreadNotifications.extras(thread))
                    .setContentTitle(title).setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(target).setAutoCancel(true).setOnlyAlertOnce(!alertAgain)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
                ThreadNotifications.deliver(context, thread, notification, new JSONObject()
                    .put("user", identity.user).put("environment", environment)
                    .put("sessionId", session).put("title", title).put("body", body).put("seq", seq));
            }
            sequence.settle(next, stream);
            JSONArray stored = new JSONArray();
            for (Long seq : sequence.streamed()) stored.put(seq);
            SharedPreferences.Editor edit = prefs.edit();
            if (!stream) edit.putLong(cursorKey, sequence.cursor());
            if (sequence.streamed().isEmpty()) edit.remove(seenKey);
            else edit.putString(seenKey, stored.toString());
            edit.apply();
        }
    }
}

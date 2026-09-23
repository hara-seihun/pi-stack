package works.kenan.piremote.kenan;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

final class ThreadNotifications {
    private static boolean resumed;
    private static String selected;

    static String key(String user, String environment, String session) {
        return "thread:" + new org.json.JSONArray(java.util.List.of(user, environment, session));
    }

    static synchronized void select(Context context, String user, String environment, String session) {
        selected = session.isEmpty() ? null : key(user, environment, session);
        clearVisible(context);
    }

    static synchronized void clear(Context context) {
        selected = null;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            if (notification.getNotification().extras.containsKey("piRemoteThread")) {
                manager.cancel(notification.getTag(), notification.getId());
            }
        }
    }

    static synchronized void resume(Context context, boolean active) {
        resumed = active;
        clearVisible(context);
    }

    static synchronized void show(Context context, String key, Notification notification) {
        if (resumed && key.equals(selected)) return;
        context.getSystemService(NotificationManager.class).notify(key, 2, notification);
    }

    static Bundle extras(String key) {
        Bundle extras = new Bundle();
        extras.putString("piRemoteThread", key);
        return extras;
    }

    private static void clearVisible(Context context) {
        if (!resumed || selected == null) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            if (selected.equals(notification.getNotification().extras.getString("piRemoteThread"))) {
                manager.cancel(notification.getTag(), notification.getId());
            }
        }
    }
}

package works.kenan.piremote.kenan;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

final class ThreadNotifications {
    private static boolean resumed;
    private static boolean ready;
    private static String selected;
    private static long generation;
    private static WeakReference<MainActivity> activity = new WeakReference<>(null);
    private static final List<PendingToast> pending = new ArrayList<>();

    private static final class PendingToast {
        final String thread;
        final Notification notification;
        final JSONObject detail;
        PendingToast(String thread, Notification notification, JSONObject detail) {
            this.thread = thread;
            this.notification = notification;
            this.detail = detail;
        }
    }

    static String key(String user, String environment, String session) {
        return "thread:" + new org.json.JSONArray(java.util.List.of(user, environment, session));
    }

    static synchronized void select(Context context, String user, String environment, String session) {
        selected = session.isEmpty() ? null : key(user, environment, session);
        ready = true;
        clearVisible(context);
        for (PendingToast toast : pending) {
            if (resumed && toast.thread.equals(selected)) continue;
            if (resumed) dispatch(context, toast);
            else show(context, toast.thread, toast.notification);
        }
        pending.clear();
    }

    static synchronized void clear(Context context) {
        generation++;
        selected = null;
        ready = false;
        pending.clear();
        clearAlerts(context);
    }

    static synchronized void clearAlerts(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            if (notification.getNotification().extras.containsKey("piRemoteThread")) {
                manager.cancel(notification.getTag(), notification.getId());
            }
        }
    }

    static synchronized void resume(Context context, MainActivity current) {
        activity = new WeakReference<>(current);
        resumed = true;
        clearVisible(context);
    }

    static synchronized void pause(Context context) {
        resumed = false;
        activity.clear();
        for (PendingToast toast : pending) show(context, toast.thread, toast.notification);
        pending.clear();
    }

    static synchronized void notReady() { ready = false; }

    static synchronized void deliver(Context context, String thread, Notification notification, JSONObject detail) {
        if (resumed && thread.equals(selected)) return;
        if (!resumed) {
            show(context, thread, notification);
        } else if (!ready || activity.get() == null) {
            pending.add(new PendingToast(thread, notification, detail));
        } else dispatch(context, new PendingToast(thread, notification, detail));
    }

    private static void dispatch(Context context, PendingToast toast) {
        long dispatchedGeneration = generation;
        MainActivity current = activity.get();
        if (current == null) { show(context, toast.thread, toast.notification); return; }
        current.runOnUiThread(() -> {
            synchronized (ThreadNotifications.class) {
                if (dispatchedGeneration != generation) return;
                if (!resumed || activity.get() != current) {
                    show(context, toast.thread, toast.notification);
                } else if (toast.thread.equals(selected)) {
                    clearVisible(context);
                } else if (!ready) {
                    pending.add(toast);
                } else current.notificationToast(toast.detail);
            }
        });
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

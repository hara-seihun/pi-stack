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
    private static final java.util.Map<String, String> managerOnly = new java.util.HashMap<>();

    static synchronized void policy(Context context, String user, String environment, JSONObject policy) throws Exception {
        String scope = key(user, environment, "");
        String view = policy.getString("view");
        if ("classic".equals(view)) managerOnly.remove(scope);
        else if ("mono".equals(view)) {
            String manager = policy.getString("managerThreadId");
            if (manager.isBlank()) throw new IllegalArgumentException("Mono notification policy requires a manager");
            managerOnly.put(scope, key(user, environment, manager));
        } else throw new IllegalArgumentException("Unknown notification view");
        pending.removeIf(toast -> !allowed(toast.notification));
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        for (StatusBarNotification notification : notifications.getActiveNotifications()) {
            if (notification.getNotification().extras.containsKey("piRemoteThread") && !allowed(notification.getNotification()))
                notifications.cancel(notification.getTag(), notification.getId());
        }
    }

    private static boolean allowed(Notification notification) {
        String thread = notification.extras.getString("piRemoteThread");
        if (thread == null) return true;
        try {
            org.json.JSONArray identity = new org.json.JSONArray(thread.substring("thread:".length()));
            String manager = managerOnly.get(key(identity.getString(0), identity.getString(1), ""));
            return manager == null || manager.equals(thread) && "attention".equals(notification.extras.getString("piRemoteKind"));
        } catch (Exception malformed) { throw new IllegalArgumentException("Invalid notification identity", malformed); }
    }

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
        managerOnly.clear();
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

    static synchronized void pageStarting() {
        ready = false;
        selected = null;
    }

    static synchronized void deliver(Context context, String thread, Notification notification, JSONObject detail) {
        if (!allowed(notification)) return;
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
                if (dispatchedGeneration != generation || !allowed(toast.notification)) return;
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
        if (!allowed(notification)) return;
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

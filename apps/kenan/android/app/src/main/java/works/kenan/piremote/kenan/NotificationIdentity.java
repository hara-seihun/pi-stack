package works.kenan.piremote.kenan;

import android.content.Context;
import android.content.SharedPreferences;

final class NotificationIdentity {
    private static RemoteSession instance;

    static synchronized RemoteSession get(Context context) {
        if (instance == null) {
            instance = new RemoteSession();
            SharedPreferences saved = context.getSharedPreferences("notification-identity", Context.MODE_PRIVATE);
            instance.replace(saved.getString("user", ""), saved.getString("session", ""));
        }
        return instance;
    }

    static boolean replace(Context context, String user, String session) {
        RemoteSession state = get(context);
        synchronized (state) {
            if (!state.replace(user, session)) return false;
            context.getSharedPreferences("notification-identity", Context.MODE_PRIVATE).edit()
                .clear().putString("user", user).putString("session", session).apply();
            context.getSharedPreferences("idle-notifications", Context.MODE_PRIVATE).edit().clear().apply();
            ThreadNotifications.clear(context);
            return true;
        }
    }
}

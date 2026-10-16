package works.kenan.piremote.kenan;

import android.Manifest;
import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.accessibility.AccessibilityManager;
import androidx.core.app.NotificationManagerCompat;

final class NativeAccess {
    static boolean accessibility(Context context, Class<? extends AccessibilityService> service) {
        AccessibilityManager manager = context.getSystemService(AccessibilityManager.class);
        if (manager == null || !manager.isEnabled()) return false;
        for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
            android.content.pm.ResolveInfo resolved = info.getResolveInfo();
            if (resolved != null && resolved.serviceInfo != null
                && context.getPackageName().equals(resolved.serviceInfo.packageName)
                && service.getName().equals(resolved.serviceInfo.name)) return true;
        }
        return false;
    }

    static boolean notifications(Context context) {
        return (Build.VERSION.SDK_INT < 33
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            && NotificationManagerCompat.from(context).areNotificationsEnabled()
            && kenazniaChannelEnabled(context);
    }

    private static boolean kenazniaChannelEnabled(Context context) {
        if (Build.VERSION.SDK_INT < 26) return true;
        android.app.NotificationChannel channel = context.getSystemService(android.app.NotificationManager.class)
            .getNotificationChannel(NotificationDelivery.CHANNEL);
        return channel == null || channel.getImportance() != android.app.NotificationManager.IMPORTANCE_NONE;
    }
}

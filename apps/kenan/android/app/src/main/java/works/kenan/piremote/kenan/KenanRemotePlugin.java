package works.kenan.piremote.kenan;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.net.Uri;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "KenanRemote", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class KenanRemotePlugin extends Plugin {
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean installingUpdate = new AtomicBoolean();
    private AppUpdates appUpdates;

    @Override
    public void load() {
        appUpdates = new AppUpdates(getContext().getApplicationContext());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(new JSObject().put("routerUrl", BuildConfig.ROUTER_URL));
    }

    @PluginMethod
    public void syncSession(PluginCall call) {
        try {
            if (NotificationIdentity.replace(getContext(), call.getString("user", ""), call.getString("session", ""))) {
                for (String key : new String[] { "environment", "sessionId", "user" }) getActivity().getIntent().removeExtra(key);
                if (NotificationIdentity.get(getContext()).current() != null
                    && getContext().getSharedPreferences("notification-settings", 0).getBoolean("enabled", false)) {
                    startNotifications();
                } else getContext().stopService(new Intent(getContext(), IdleNotificationService.class));
            }
            call.resolve();
        } catch (IllegalArgumentException failure) { call.reject(failure.getMessage(), failure); }
    }

    @PluginMethod
    public void checkAppUpdate(PluginCall call) {
        updateExecutor.execute(() -> {
            try {
                AppUpdates.Release release = appUpdates.check();
                JSObject result = new JSObject().put("installed", new JSObject()
                    .put("revision", BuildConfig.RELEASE_REVISION)
                    .put("versionCode", BuildConfig.VERSION_CODE)
                    .put("applicationId", BuildConfig.APPLICATION_ID));
                result.put("release", release == null ? org.json.JSONObject.NULL : new JSObject()
                    .put("revision", release.revision).put("versionCode", release.versionCode));
                call.resolve(result);
            } catch (Exception failure) {
                call.reject("Could not check for an app update. " + failure.getMessage(), failure);
            }
        });
    }

    @PluginMethod
    public void installAppUpdate(PluginCall call) {
        if (!installingUpdate.compareAndSet(false, true)) {
            call.reject("An app update is already in progress. Return from Android settings or the installer first.");
            return;
        }
        updateExecutor.execute(() -> {
            try {
                File apk = appUpdates.downloadCurrent();
                call.getData().put("updateRevision", apk.getName().replace(".apk", ""));
                getActivity().runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getContext().getPackageName()));
                            startActivityForResult(call, settings, "appInstallPermission");
                        } else openAppInstaller(call, apk);
                    } catch (Exception failure) { failAppInstall(call, failure); }
                });
            } catch (Exception failure) { failAppInstall(call, failure); }
        });
    }

    @ActivityCallback
    private void appInstallPermission(PluginCall call, ActivityResult result) {
        if (call == null) {
            installingUpdate.set(false);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            installingUpdate.set(false);
            call.reject("Allow installs from Kenan in Android settings, then tap Update app again. The downloaded APK is saved.");
            return;
        }
        try { openAppInstaller(call, appUpdates.downloadedFile(call.getString("updateRevision"))); }
        catch (Exception failure) { failAppInstall(call, failure); }
    }

    private void openAppInstaller(PluginCall call, File apk) throws java.io.IOException {
        if (!apk.isFile()) throw new java.io.IOException("The saved APK is unavailable. Tap Update app to download it again.");
        Uri uri = FileProvider.getUriForFile(getContext(), BuildConfig.APPLICATION_ID + ".fileprovider", apk);
        Intent installer = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        installer.setClipData(android.content.ClipData.newRawUri("Kenan update", uri));
        getActivity().startActivity(installer);
        installingUpdate.set(false);
        call.resolve(new JSObject().put("status", "installer-opened"));
    }

    private void failAppInstall(PluginCall call, Exception failure) {
        installingUpdate.set(false);
        call.reject("Could not open the app update. " + failure.getMessage()
            + " Retry Update app. A checked download is kept until installation.", failure);
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "select");
        getActivity().runOnUiThread(() -> {
            boolean played = NativeHaptics.play(getActivity().getWindow().getDecorView(), kind);
            call.resolve(new JSObject().put("played", played));
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            getBridge().getWebView().setKeepScreenOn(enabled);
            call.resolve();
        });
    }

    @PluginMethod
    public void notifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            if (Boolean.TRUE.equals(call.getBoolean("request", false))) {
                requestPermissionForAlias("notifications", call, "notificationPermission");
            } else call.resolve(new JSObject().put("enabled", false));
            return;
        }
        notificationPermission(call);
    }

    @PermissionCallback
    private void notificationPermission(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
        boolean enabled = granted && NotificationIdentity.get(getContext()).current() != null;
        if (enabled) {
            getContext().getSharedPreferences("notification-settings", 0).edit().putBoolean("enabled", true).apply();
            startNotifications();
        }
        call.resolve(new JSObject().put("enabled", enabled));
    }

    private void startNotifications() {
        androidx.core.content.ContextCompat.startForegroundService(getContext(), new Intent(getContext(), IdleNotificationService.class));
    }

    @PluginMethod
    public void notificationThread(PluginCall call) {
        RemoteSession state = NotificationIdentity.get(getContext());
        synchronized (state) {
            RemoteSession.Identity identity = state.current();
            if (identity != null && identity.user.equals(call.getString("user", ""))) {
                ThreadNotifications.select(getContext(), identity.user,
                    call.getString("environment", ""), call.getString("sessionId", ""));
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void notificationTarget(PluginCall call) {
        Intent intent = getActivity().getIntent();
        JSObject target = new JSObject();
        RemoteSession.Identity identity = NotificationIdentity.get(getContext()).current();
        boolean owned = identity != null && identity.user.equals(intent.getStringExtra("user"));
        for (String key : new String[] { "environment", "sessionId", "user" }) {
            if (owned) target.put(key, intent.getStringExtra(key));
            intent.removeExtra(key);
        }
        call.resolve(target);
    }

    @Override
    protected void handleOnDestroy() {
        updateExecutor.shutdownNow();
    }
}

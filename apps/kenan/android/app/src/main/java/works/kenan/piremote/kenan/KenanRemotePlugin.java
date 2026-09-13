package works.kenan.piremote.kenan;

import android.util.Log;
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

import com.getcapacitor.JSArray;
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
    private final ExecutorService transportExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "kenan-transport");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService warmingExecutor = Executors.newCachedThreadPool();
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean installingUpdate = new AtomicBoolean();
    private RemoteEnvironment environments;
    private AppUpdates appUpdates;

    @Override
    public void load() {
        environments = new RemoteEnvironment(getContext().getApplicationContext());
        appUpdates = new AppUpdates(getContext().getApplicationContext());
        for (RemoteEnvironment.Endpoint endpoint : environments.all()) warmingExecutor.execute(() -> {
            try {
                RemoteConnections.forEndpoint(endpoint).prepare(endpoint);
            } catch (Exception failure) {
                Log.w("KenanRemote", "Could not warm " + endpoint.id, failure);
            }
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(snapshot());
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        transportExecutor.execute(() -> {
            try {
                RemoteTransport transport = RemoteConnections.forEndpoint(environments.current());
                if (Boolean.TRUE.equals(call.getBoolean("reconnect", false))) transport.close();
                transport.prepare(environments.current());
                call.resolve(snapshot());
            } catch (Exception failure) {
                call.reject(failure.getMessage(), failure);
            }
        });
    }

    @PluginMethod
    public void checkAppUpdate(PluginCall call) {
        RemoteEnvironment.Endpoint endpoint = environments.current();
        updateExecutor.execute(() -> {
            try {
                AppUpdates.Release release = appUpdates.check(endpoint);
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
        RemoteEnvironment.Endpoint endpoint = environments.current();
        updateExecutor.execute(() -> {
            try {
                File apk = appUpdates.downloadCurrent(endpoint);
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
    public void select(PluginCall call) {
        String id = call.getString("id", "");
        String user = call.getString("user", "");
        transportExecutor.execute(() -> {
            try {
                RemoteEnvironment.Endpoint current = environments.current();
                RemoteEnvironment.Endpoint next = RemoteEnvironment.find(id);
                RemoteConnections.forEndpoint(next).verify(next, user);
                if (current != next) {
                    environments.select(id);
                }
                call.resolve(snapshot());
            } catch (Exception failure) {
                call.reject(failure.getMessage(), failure);
            }
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
        if (granted) {
            Intent intent = new Intent(getContext(), IdleNotificationService.class);
            intent.putExtra("user", call.getString("user", ""));
            androidx.core.content.ContextCompat.startForegroundService(getContext(), intent);
        }
        call.resolve(new JSObject().put("enabled", granted));
    }

    @PluginMethod
    public void notificationThread(PluginCall call) {
        ThreadNotifications.select(getContext(), call.getString("user", ""),
            call.getString("environment", ""), call.getString("sessionId", ""));
        call.resolve();
    }

    @PluginMethod
    public void notificationTarget(PluginCall call) {
        Intent intent = getActivity().getIntent();
        JSObject target = new JSObject();
        for (String key : new String[] { "environment", "sessionId", "user" }) {
            target.put(key, intent.getStringExtra(key));
            intent.removeExtra(key);
        }
        call.resolve(target);
    }

    private JSObject snapshot() {
        RemoteEnvironment.Endpoint selected = environments.current();
        JSArray choices = new JSArray();
        for (RemoteEnvironment.Endpoint endpoint : environments.all()) {
            choices.put(new JSObject()
                .put("id", endpoint.id)
                .put("name", endpoint.name));
        }
        return new JSObject()
            .put("id", selected.id)
            .put("name", selected.name)
            .put("baseUrl", selected.baseUrl)
            .put("requiresUnlock", selected.requiresUnlock)
            .put("requiresPreparation", selected.authentication == RemoteEnvironment.Authentication.SSH)
            .put("environments", choices);
    }

    @Override
    protected void handleOnDestroy() {
        transportExecutor.shutdownNow();
        warmingExecutor.shutdownNow();
        updateExecutor.shutdownNow();
    }
}

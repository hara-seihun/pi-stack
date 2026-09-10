package works.kenan.piremote.kenan;

import android.util.Log;
import android.Manifest;
import android.content.Intent;
import android.os.Build;
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
    private RemoteEnvironment environments;

    @Override
    public void load() {
        environments = new RemoteEnvironment(getContext().getApplicationContext());
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
    }
}

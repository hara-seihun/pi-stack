package works.kenan.piremote.kenan.dev;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "KenanRemote")
public final class KenanRemotePlugin extends Plugin {
    private final ExecutorService transportExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "kenan-dev-transport");
        thread.setDaemon(true);
        return thread;
    });
    private final RemoteTransport transport = new RemoteTransport();
    private RemoteEnvironment environments;

    @Override
    public void load() {
        environments = new RemoteEnvironment(getContext().getApplicationContext());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(snapshot());
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        transportExecutor.execute(() -> {
            try {
                transport.ensure(environments.current());
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
    public void select(PluginCall call) {
        String id = call.getString("id", "");
        transportExecutor.execute(() -> {
            try {
                RemoteEnvironment.Endpoint current = environments.current();
                RemoteEnvironment.Endpoint next = RemoteEnvironment.find(id);
                transport.ensure(next);
                if (current != next) {
                    environments.select(id);
                    if (next.authentication == RemoteEnvironment.Authentication.DIRECT)
                        transport.environmentChanged();
                }
                call.resolve(snapshot());
            } catch (Exception failure) {
                call.reject(failure.getMessage(), failure);
            }
        });
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
            .put("environments", choices);
    }

    @Override
    protected void handleOnDestroy() {
        transport.close();
        transportExecutor.shutdownNow();
    }
}

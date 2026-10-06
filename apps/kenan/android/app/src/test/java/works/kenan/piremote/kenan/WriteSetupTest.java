package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.Bridge;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.cordova.MockCordovaInterfaceImpl;
import java.util.List;
import java.util.Map;
import org.apache.cordova.CordovaPreferences;
import org.apache.cordova.PluginManager;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class,
    instrumentedPackages = "com.getcapacitor", shadows = WriteSetupTest.NativeBridge.class)
public class WriteSetupTest {
    @Implements(Bridge.class)
    public static class NativeBridge {
        @Implementation protected void __constructor__(AppCompatActivity context, com.getcapacitor.ServerPath serverPath,
            androidx.fragment.app.Fragment fragment, android.webkit.WebView webView, List<Class<? extends Plugin>> plugins,
            List<Plugin> instances, MockCordovaInterfaceImpl cordova, PluginManager manager,
            CordovaPreferences preferences, CapConfig config) { }
        @Implementation public Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Implementation protected Map<String, PermissionState> getPermissionStates(Plugin plugin) {
            return Map.of("microphone", PermissionState.GRANTED, "notifications", PermissionState.GRANTED);
        }
    }
    private static class Call extends PluginCall {
        boolean resolved;
        String rejected;
        JSObject result;
        Call(JSObject data) { super(null, "KenanRemote", "test", "writeSetup", data); }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject data) { result = data; resolved = true; }
        @Override public void reject(String message) { rejected = message; }
    }
    private KenanRemotePlugin plugin() {
        KenanRemotePlugin plugin = new KenanRemotePlugin();
        plugin.setBridge(new Bridge(null, null, List.of(), null, null, null, null));
        return plugin;
    }
    private android.content.SharedPreferences settings() {
        return RuntimeEnvironment.getApplication().getSharedPreferences("write-settings", 0);
    }
    @After public void clear() throws Exception {
        settings().edit().clear().commit();
        KenanOverlayTest.clearSharedOverlay();
    }
    @Test public void setupImmediatelyCancelsDictationAndRefreshesKeyboardPreference() {
        WriteAccessibilityService service = org.robolectric.Robolectric.buildService(WriteAccessibilityService.class).get();
        org.robolectric.util.ReflectionHelpers.setStaticField(WriteAccessibilityService.class, "active", service);
        org.robolectric.util.ReflectionHelpers.setField(service, "shown", true);
        org.robolectric.util.ReflectionHelpers.setField(service, "phase", NativeState.WritePhase.FINISHING_CONNECTING);
        KenanRemotePlugin plugin = plugin();
        Call disable = new Call(new JSObject().put("step", "enabled").put("enabled", false));
        plugin.writeSetup(disable);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(disable.resolved);
        assertFalse(service.busy());
        assertFalse(service.visible());
        settings().edit().putBoolean("overlayEnabled", true).commit();
        org.robolectric.util.ReflectionHelpers.setField(service, "shown", true);
        Call keyboard = new Call(new JSObject().put("step", "keyboard").put("required", false));
        plugin.writeSetup(keyboard);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(keyboard.resolved);
        assertFalse(settings().getBoolean("keyboardRequired", true));
        assertFalse("refresh hides the stale dot without a focused field", service.visible());
    }
    @Test public void enabledStatusDefaultsOnAndReportsPersistentChanges() {
        KenanRemotePlugin plugin = plugin();
        Call initial = new Call(new JSObject());
        plugin.writeStatus(initial);
        assertEquals(Boolean.TRUE, initial.result.opt("overlayEnabled"));
        for (boolean enabled : new boolean[] { false, true }) {
            Call change = new Call(new JSObject().put("step", "enabled").put("enabled", enabled));
            plugin.writeSetup(change);
            assertTrue(change.resolved);
            assertNull(change.rejected);
            assertEquals(enabled, settings().getBoolean("overlayEnabled", !enabled));
            Call status = new Call(new JSObject());
            plugin().writeStatus(status);
            assertEquals(enabled, status.result.opt("overlayEnabled"));
        }
    }
    @Test public void missingAndNonbooleanEnabledRejectWithoutChangingPreferences() {
        KenanRemotePlugin plugin = plugin();
        for (Object value : new Object[] { null, org.json.JSONObject.NULL, "false", 0, new JSObject() }) {
            JSObject options = new JSObject().put("step", "enabled");
            if (value != null) options.put("enabled", value);
            Call call = new Call(options);
            plugin.writeSetup(call);
            assertNotNull(call.rejected);
            assertFalse(call.resolved);
            assertFalse(settings().contains("overlayEnabled"));
        }
    }
}

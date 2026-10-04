package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class, instrumentedPackages = "com.getcapacitor",
    shadows = { WriteSetupTest.NativeBridge.class, PhoneSetupTest.SettingsLauncher.class })
public class PhoneSetupTest {
    @Implements(Plugin.class)
    public static class SettingsLauncher {
        static Intent intent;
        static String callback;
        @Implementation public void startActivityForResult(PluginCall call, Intent requested, String name) {
            intent = requested;
            callback = name;
        }
    }
    private static class Call extends PluginCall {
        boolean resolved;
        String rejected;
        JSObject result;
        Call(JSObject data) { super(null, "KenanRemote", "test", "phoneSetup", data); }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject data) { result = data; resolved = true; }
        @Override public void reject(String message, String code, Exception failure, JSObject data) { rejected = code; }
    }
    private Context context() { return RuntimeEnvironment.getApplication(); }
    private KenanRemotePlugin plugin() {
        KenanRemotePlugin plugin = new KenanRemotePlugin();
        plugin.setBridge(new Bridge(null, null, List.of(), null, null, null, null));
        return plugin;
    }
    private AccessibilityServiceInfo service(Class<?> type) {
        ResolveInfo resolved = new ResolveInfo();
        resolved.serviceInfo = new ServiceInfo();
        resolved.serviceInfo.packageName = context().getPackageName();
        resolved.serviceInfo.name = type.getName();
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        ReflectionHelpers.setField(info, "mResolveInfo", resolved);
        return info;
    }
    private void accessibility(Class<?>... enabled) {
        AccessibilityManager manager = context().getSystemService(AccessibilityManager.class);
        Shadows.shadowOf(manager).setEnabled(enabled.length > 0);
        Shadows.shadowOf(manager).setEnabledAccessibilityServiceList(
            java.util.Arrays.stream(enabled).map(this::service).toList());
    }
    @After public void clear() {
        SettingsLauncher.intent = null;
        SettingsLauncher.callback = null;
        context().getSharedPreferences("notification-settings", 0).edit().clear().commit();
        context().getSharedPreferences("write-settings", 0).edit().clear().commit();
    }
    @Test public void writeSettingsWaitsForReturnAndSerializesRequests() {
        accessibility(PhoneAccessibilityService.class);
        KenanRemotePlugin plugin = plugin();
        Call call = new Call(new JSObject().put("step", "writeAccessibility").put("instruction", "Enable Pi Stack Write, then return"));
        plugin.phoneSetup(call);
        assertFalse(call.resolved);
        assertNull(call.rejected);
        assertEquals(Settings.ACTION_ACCESSIBILITY_SETTINGS, SettingsLauncher.intent.getAction());
        assertEquals(new ComponentName(context(), WriteAccessibilityService.class).flattenToString(),
            SettingsLauncher.intent.getStringExtra(Intent.EXTRA_COMPONENT_NAME));
        assertEquals("phoneSettingsReturned", SettingsLauncher.callback);
        assertEquals("Enable Pi Stack Write, then return", org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
        Call overlapping = new Call(new JSObject().put("step", "microphone"));
        plugin.phoneSetup(overlapping);
        assertEquals("busy", overlapping.rejected);
        assertFalse(overlapping.resolved);
        accessibility(PhoneAccessibilityService.class, WriteAccessibilityService.class);
        ReflectionHelpers.callInstanceMethod(plugin, SettingsLauncher.callback,
            ReflectionHelpers.ClassParameter.from(PluginCall.class, call),
            ReflectionHelpers.ClassParameter.from(ActivityResult.class, new ActivityResult(android.app.Activity.RESULT_CANCELED, null)));
        assertTrue(call.resolved);
        assertTrue(call.result.getJSObject("capabilities").optBoolean("writeAccessibility"));
        SettingsLauncher.intent = null;
        Call granted = new Call(new JSObject().put("step", "writeAccessibility"));
        plugin.phoneSetup(granted);
        assertTrue(granted.resolved);
        assertNull(SettingsLauncher.intent);
    }
    @Test public void decliningWriteAccessReturnsMissingGrantAndAllowsRetry() {
        accessibility();
        KenanRemotePlugin plugin = plugin();
        Call call = new Call(new JSObject().put("step", "writeAccessibility"));
        plugin.phoneSetup(call);
        assertFalse(call.resolved);
        ReflectionHelpers.callInstanceMethod(plugin, SettingsLauncher.callback,
            ReflectionHelpers.ClassParameter.from(PluginCall.class, call),
            ReflectionHelpers.ClassParameter.from(ActivityResult.class, new ActivityResult(android.app.Activity.RESULT_CANCELED, null)));
        assertTrue(call.resolved);
        assertFalse(call.result.getJSObject("capabilities").optBoolean("writeAccessibility"));
        SettingsLauncher.intent = null;
        Call retry = new Call(new JSObject().put("step", "writeAccessibility"));
        plugin.phoneSetup(retry);
        assertFalse(retry.resolved);
        assertNull(retry.rejected);
        assertNotNull(SettingsLauncher.intent);
    }
    @Test public void writeGrantIsIndependentOfPhoneServiceAndOverlayPreferenceAndRevocation() {
        accessibility(PhoneAccessibilityService.class);
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("writeAccessibility"));
        accessibility(WriteAccessibilityService.class);
        context().getSharedPreferences("write-settings", 0).edit().putBoolean("overlayEnabled", false).commit();
        assertTrue(PhoneControlService.capabilities(context()).optBoolean("writeAccessibility"));
        Call write = new Call(new JSObject());
        plugin().writeStatus(write);
        assertTrue(write.result.optBoolean("accessibility"));
        assertFalse(write.result.optBoolean("overlayEnabled"));
        Shadows.shadowOf(context().getSystemService(AccessibilityManager.class)).setEnabled(false);
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("writeAccessibility"));
        accessibility();
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("writeAccessibility"));
    }
    @Test public void approximateLocationDoesNotCompletePreciseOrBackgroundGrant() {
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION);
        assertFalse(PhoneData.capabilities(context()).optBoolean("location"));
        assertFalse(PhoneData.capabilities(context()).optBoolean("backgroundLocation"));
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION);
        assertFalse(PhoneData.capabilities(context()).optBoolean("location"));
        assertFalse(PhoneData.capabilities(context()).optBoolean("backgroundLocation"));
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION);
        assertTrue(PhoneData.capabilities(context()).optBoolean("location"));
        assertTrue(PhoneData.capabilities(context()).optBoolean("backgroundLocation"));
    }
    @Test public void installPackageGrantWaitsForSettingsWithoutInstallingAnything() {
        Shadows.shadowOf(context().getPackageManager()).setCanRequestPackageInstalls(false);
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("installPackages"));
        KenanRemotePlugin plugin = plugin();
        Call call = new Call(new JSObject().put("step", "installPackages"));
        plugin.phoneSetup(call);
        assertFalse(call.resolved);
        assertNull(call.rejected);
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, SettingsLauncher.intent.getAction());
        assertEquals("package:" + context().getPackageName(), SettingsLauncher.intent.getDataString());
        ReflectionHelpers.callInstanceMethod(plugin, SettingsLauncher.callback,
            ReflectionHelpers.ClassParameter.from(PluginCall.class, call),
            ReflectionHelpers.ClassParameter.from(ActivityResult.class, new ActivityResult(android.app.Activity.RESULT_CANCELED, null)));
        assertTrue(call.resolved);
        assertFalse(call.result.getJSObject("capabilities").optBoolean("installPackages"));
        Shadows.shadowOf(context().getPackageManager()).setCanRequestPackageInstalls(true);
        SettingsLauncher.intent = null;
        Call granted = new Call(new JSObject().put("step", "installPackages"));
        plugin.phoneSetup(granted);
        assertTrue(granted.resolved);
        assertTrue(granted.result.getJSObject("capabilities").optBoolean("installPackages"));
        assertNull(SettingsLauncher.intent);
    }
    @Test public void revokedSystemNotificationsCannotRemainEnabled() {
        context().getSharedPreferences("notification-settings", 0).edit().putBoolean("enabled", true).commit();
        Shadows.shadowOf(context().getSystemService(NotificationManager.class)).setNotificationsEnabled(false);
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("notifications"));
        Call write = new Call(new JSObject());
        plugin().writeStatus(write);
        assertFalse(write.result.optBoolean("notification"));
        Call status = new Call(new JSObject());
        plugin().notifications(status);
        assertTrue(status.resolved);
        assertFalse(status.result.optBoolean("enabled"));
        assertFalse(context().getSharedPreferences("notification-settings", 0).getBoolean("enabled", true));
    }
}

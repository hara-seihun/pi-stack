package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.provider.Settings;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class PhoneSetupTest {
    private Context context() { return RuntimeEnvironment.getApplication(); }
    private JSONObject completeGrants() throws Exception {
        JSONObject grants = new JSONObject();
        for (var step : PermissionSetup.REQUIRED) grants.put(step.wire(), true);
        return grants;
    }
    @Test public void everyRequiredRevocationReturnsToSetupWithoutSavedChecklist() throws Exception {
        JSONObject grants = completeGrants();
        assertTrue(PermissionSetup.evaluate(grants) instanceof PermissionSetup.Complete);
        for (var revoked : PermissionSetup.REQUIRED) {
            grants.put(revoked.wire(), false);
            var state = (PermissionSetup.NeedsPermissions) PermissionSetup.evaluate(grants);
            assertEquals(java.util.List.of(revoked), state.missing());
            assertEquals("needs-permissions", state.wire().getString("state"));
            grants.put(revoked.wire(), true);
            assertTrue(PermissionSetup.evaluate(grants) instanceof PermissionSetup.Complete);
        }
        grants.remove("camera");
        assertTrue(PermissionSetup.evaluate(grants) instanceof PermissionSetup.NeedsPermissions);
        grants.put("camera", "true");
        assertTrue("wire strings must not impersonate grants", PermissionSetup.evaluate(grants) instanceof PermissionSetup.NeedsPermissions);
    }
    @Test public void provisioningIsSeparateAndCannotProduceEmptyMissingState() throws Exception {
        assertFalse(PermissionSetup.REQUIRED.contains(NativeState.PhoneSetup.DEVICE_OWNER));
        assertFalse(PermissionSetup.REQUIRED.contains(NativeState.PhoneSetup.SECURE_SETTINGS));
        assertThrows(IllegalArgumentException.class, () -> new PermissionSetup.NeedsPermissions(java.util.List.of()));
        assertTrue(PermissionSetup.settings(context(), NativeState.PhoneSetup.DEVICE_OWNER) instanceof PermissionSetup.Unsupported);
        assertTrue(PermissionSetup.settings(context(), NativeState.PhoneSetup.ALL_FILES) instanceof PermissionSetup.Unsupported);
        var notifications = (PermissionSetup.OpenSettings) PermissionSetup.settings(context(), NativeState.PhoneSetup.NOTIFICATIONS);
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, notifications.intent().getAction());
        assertEquals(context().getPackageName(), notifications.intent().getStringExtra(Settings.EXTRA_APP_PACKAGE));
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
    @Test public void notificationRevocationRetainsDurableReplayPosition() throws Exception {
        NotificationIdentity.get(context()).replace("fixture-person", "fixture-session");
        var identity = NotificationIdentity.get(context()).current();
        Shadows.shadowOf(context().getSystemService(NotificationManager.class)).setNotificationsEnabled(false);
        JSONObject feed = new JSONObject().put("cursor", 19).put("notifications", new org.json.JSONArray());
        assertThrows(NotificationDelivery.PermissionRequired.class,
            () -> NotificationDelivery.receive(context(), identity, "fixture-home", "Fixture", feed, false));
        assertEquals(-1, NotificationDelivery.cursor(context(), "fixture-home"));
    }
    @Test public void kenazniaUsesHighestOrdinaryPriorityAndRevocationInvalidatesNotifications() {
        NotificationDelivery.channel(context());
        var manager = context().getSystemService(NotificationManager.class);
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(NotificationDelivery.CHANNEL).getImportance());
        assertTrue(manager.getNotificationChannel(NotificationDelivery.CHANNEL).shouldVibrate());
        Shadows.shadowOf(manager).setNotificationsEnabled(false);
        assertFalse(NativeAccess.notifications(context()));
        assertFalse(PhoneControlService.capabilities(context()).optBoolean("notifications"));
        assertFalse(PermissionSetup.complete(context()));
    }
}

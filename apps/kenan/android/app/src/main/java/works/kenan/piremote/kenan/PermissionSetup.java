package works.kenan.piremote.kenan;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

final class PermissionSetup {
    sealed interface State permits Complete, NeedsPermissions { JSONObject wire(); }
    record Complete() implements State {
        public JSONObject wire() { return json("complete", null); }
    }
    record NeedsPermissions(List<NativeState.PhoneSetup> missing) implements State {
        NeedsPermissions {
            missing = List.copyOf(missing);
            if (missing.isEmpty()) throw new IllegalArgumentException("Missing permissions must be nonempty");
        }
        public JSONObject wire() { return json("needs-permissions", missing); }
    }
    static final List<NativeState.PhoneSetup> REQUIRED = List.of(
        NativeState.PhoneSetup.NOTIFICATIONS, NativeState.PhoneSetup.CONTACTS, NativeState.PhoneSetup.CALENDAR,
        NativeState.PhoneSetup.LOCATION, NativeState.PhoneSetup.BACKGROUND_LOCATION, NativeState.PhoneSetup.SMS,
        NativeState.PhoneSetup.CALL_LOG, NativeState.PhoneSetup.PHONE, NativeState.PhoneSetup.CAMERA,
        NativeState.PhoneSetup.MICROPHONE, NativeState.PhoneSetup.ACCESSIBILITY, NativeState.PhoneSetup.NOTIFICATION_ACCESS,
        NativeState.PhoneSetup.OVERLAY, NativeState.PhoneSetup.ALL_FILES, NativeState.PhoneSetup.USAGE,
        NativeState.PhoneSetup.WRITE_SETTINGS, NativeState.PhoneSetup.BATTERY, NativeState.PhoneSetup.DEVICE_ADMIN,
        NativeState.PhoneSetup.INSTALL_PACKAGES);

    static State evaluate(JSONObject capabilities) {
        List<NativeState.PhoneSetup> missing = REQUIRED.stream().filter(step -> !Boolean.TRUE.equals(capabilities.opt(step.wire()))).toList();
        return missing.isEmpty() ? new Complete() : new NeedsPermissions(missing);
    }
    static State state(Context context) {
        JSONObject grants = PhoneControlService.capabilities(context);
        // Setup measures the grant; an accessibility-service connection is transport state.
        try { grants.put("accessibility", NativeAccess.accessibility(context, PhoneAccessibilityService.class)); }
        catch (org.json.JSONException defect) { throw new IllegalStateException(defect); }
        return evaluate(grants);
    }
    static boolean complete(Context context) { return state(context) instanceof Complete; }
    static JSONObject wire(State state) { return state.wire(); }
    private static JSONObject json(String state, List<NativeState.PhoneSetup> missing) {
        try {
            JSONObject value = new JSONObject().put("state", state);
            if (missing != null) value.put("missing", new JSONArray(missing.stream().map(NativeState.PhoneSetup::wire).toList()));
            return value;
        } catch (org.json.JSONException defect) { throw new IllegalStateException(defect); }
    }
    static List<String> runtime(NativeState.PhoneSetup step) {
        return switch (step) {
            case CONTACTS -> List.of(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS);
            case CALENDAR -> List.of(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR);
            case LOCATION -> List.of(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION);
            case BACKGROUND_LOCATION -> Build.VERSION.SDK_INT >= 29 ? List.of(Manifest.permission.ACCESS_BACKGROUND_LOCATION) : List.of();
            case SMS -> List.of(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS);
            case CALL_LOG -> List.of(Manifest.permission.READ_CALL_LOG);
            case PHONE -> List.of(Manifest.permission.CALL_PHONE);
            case CAMERA -> List.of(Manifest.permission.CAMERA);
            case MICROPHONE -> List.of(Manifest.permission.RECORD_AUDIO);
            case NOTIFICATIONS -> Build.VERSION.SDK_INT >= 33 ? List.of(Manifest.permission.POST_NOTIFICATIONS) : List.of();
            case ACCESSIBILITY, NOTIFICATION_ACCESS, OVERLAY, BATTERY, ALL_FILES, USAGE, WRITE_SETTINGS,
                 INSTALL_PACKAGES, DEVICE_ADMIN, DEVICE_OWNER, SECURE_SETTINGS -> List.of();
        };
    }
    sealed interface SettingsRequest permits OpenSettings, Unsupported {}
    record OpenSettings(Intent intent) implements SettingsRequest {}
    record Unsupported(String message) implements SettingsRequest {}
    static SettingsRequest settings(Context context, NativeState.PhoneSetup step) {
        Uri app = Uri.parse("package:" + context.getPackageName());
        return switch (step) {
            case CONTACTS, CALENDAR, LOCATION, BACKGROUND_LOCATION, SMS, CALL_LOG, PHONE, CAMERA, MICROPHONE ->
                new OpenSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app));
            case NOTIFICATIONS -> new OpenSettings(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName()));
            case ACCESSIBILITY -> new OpenSettings(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .putExtra(Intent.EXTRA_COMPONENT_NAME, new ComponentName(context, PhoneAccessibilityService.class).flattenToString()));
            case NOTIFICATION_ACCESS -> new OpenSettings(new Intent(Build.VERSION.SDK_INT >= 30 ? Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS : Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, new ComponentName(context, PhoneNotificationService.class).flattenToString()));
            case OVERLAY -> new OpenSettings(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, app));
            case BATTERY -> new OpenSettings(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, app));
            case ALL_FILES -> Build.VERSION.SDK_INT >= 30
                ? new OpenSettings(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, app))
                : new Unsupported("Complete phone setup requires Android 11 or newer for shared-file access.");
            case USAGE -> new OpenSettings(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, app));
            case WRITE_SETTINGS -> new OpenSettings(new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, app));
            case INSTALL_PACKAGES -> new OpenSettings(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, app));
            case DEVICE_ADMIN -> new OpenSettings(new Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                .putExtra(android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN, new ComponentName(context, PhoneAdminReceiver.class))
                .putExtra(android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Allow Kenan to lock this owned phone. Device Owner provisioning is separate."));
            case DEVICE_OWNER -> new Unsupported("Device Owner requires separate Android enterprise provisioning, not a settings toggle.");
            case SECURE_SETTINGS -> new Unsupported("Secure settings requires an authorized shell grant or system provisioning, not a settings toggle.");
        };
    }
    static String instruction(NativeState.PhoneSetup step) {
        return switch (step) {
            case CONTACTS -> "Allow contacts access.";
            case CALENDAR -> "Allow calendar access.";
            case LOCATION -> "Allow precise location while using Kenan.";
            case BACKGROUND_LOCATION -> "Open Permissions → Location → Allow all the time, then return to Kenan.";
            case SMS -> "Allow SMS access.";
            case CALL_LOG -> "Allow call-history access.";
            case PHONE -> "Allow phone calls.";
            case CAMERA -> "Allow camera access for supported phone and Meet flows.";
            case MICROPHONE -> "Allow microphone access for Meet and calling.";
            case NOTIFICATIONS -> "Allow Kenan notifications, including the high-priority Kenaznia channel.";
            case ACCESSIBILITY -> "Enable Kenan Phone control in Accessibility, then return.";
            case NOTIFICATION_ACCESS -> "Allow Kenan notification access, then return.";
            case OVERLAY -> "Allow Kenan to display over other apps, then return.";
            case BATTERY -> "Allow unrestricted background battery use, then return.";
            case ALL_FILES -> "Allow access to manage all files, then return.";
            case USAGE -> "Allow usage access, then return.";
            case WRITE_SETTINGS -> "Allow modifying system settings, then return.";
            case INSTALL_PACKAGES -> "Allow updates from Kenan, then return.";
            case DEVICE_ADMIN -> "Activate Kenan as a device administrator for screen locking, then return.";
            case DEVICE_OWNER -> "Device Owner requires separate provisioning.";
            case SECURE_SETTINGS -> "Secure settings requires a separate authorized shell grant.";
        };
    }
    private PermissionSetup() {}
}

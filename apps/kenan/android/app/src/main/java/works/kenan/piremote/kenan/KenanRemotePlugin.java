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
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
    @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS }),
    @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }),
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    @Permission(alias = "backgroundLocation", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
    @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS }),
    @Permission(alias = "callLog", strings = { Manifest.permission.READ_CALL_LOG }),
    @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE })
})
public final class KenanRemotePlugin extends Plugin {
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean installingUpdate = new AtomicBoolean();
    private final AtomicBoolean requestingPhoneAccess = new AtomicBoolean();
    private AppUpdates appUpdates;
    private WebBundles webBundles;

    @Override
    public void load() {
        appUpdates = new AppUpdates(getContext().getApplicationContext());
        webBundles = new WebBundles(getContext().getApplicationContext());
        PhoneControlService.start(getContext());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        updateExecutor.execute(() -> {
            try {
                RouterConnection.select();
                if (!RouterConnection.publicUrl(RouterConnection.routerUrl())) { resolveConnection(call); return; }
                String token = RouterConnection.token();
                int status = token.isEmpty() ? 302 : RouterConnection.accessStatus(token);
                if (status == 200) {
                    getActivity().runOnUiThread(() -> AccessSignIn.embeddedCookie(() -> resolveConnection(call)));
                } else if (RouterConnection.rejected(status)) {
                    RouterConnection.accept("");
                    getActivity().runOnUiThread(() -> AccessSignIn.open(getActivity(), updateExecutor,
                        () -> resolveConnection(call), call::reject));
                } else call.reject("Kenan sign-in check returned HTTP " + status + ". Retry when the connection is restored.");
            } catch (java.io.IOException failure) { call.reject("Could not reach Kenan. Check your connection and retry.", failure); }
        });
    }

    private void resolveConnection(PluginCall call) {
        call.resolve(new JSObject().put("routerUrl", RouterConnection.routerUrl())
            .put("accessToken", RouterConnection.publicUrl(RouterConnection.routerUrl()) ? RouterConnection.token() : ""));
    }

    @PluginMethod
    public void openEditor(PluginCall call) {
        Object suppliedUrl = call.getData().opt("url");
        Object suppliedTicket = call.getData().opt("ticket");
        if (!(suppliedUrl instanceof String url) || url.length() > 2048
            || !(suppliedTicket instanceof String ticket) || !ticket.matches("[A-Za-z0-9_-]{43}")) {
            call.reject("An editor handoff URL and ticket are required", "invalid_args"); return;
        }
        RemoteSession state = NotificationIdentity.get(getContext());
        RemoteSession.Identity identity = state.current();
        if (identity == null) { call.reject("Unlock before opening the editor", "session_expired"); return; }
        long issuedAt = android.os.SystemClock.elapsedRealtime();
        updateExecutor.execute(() -> {
            try {
                org.json.JSONObject config = RemoteTransport.get(RouterConnection.routerUrl() + "/v1/editor", identity);
                if (!Boolean.TRUE.equals(config.opt("ok")) || !(config.opt("origin") instanceof String origin)) {
                    call.reject("Router returned an invalid editor configuration", "protocol_error"); return;
                }
                EditorHandoff.Validation checked = EditorHandoff.validate(url, ticket, origin,
                    RouterConnection.routerUrl(), BuildConfig.ROUTER_URL, BuildConfig.PUBLIC_ROUTER_URL,
                    getBridge().getServerUrl(), getBridge().getAppUrl(), "http://localhost", "https://localhost");
                if (checked instanceof EditorHandoff.Rejected rejected) {
                    call.reject("Invalid editor handoff: " + rejected.failure().name(), "invalid_args"); return;
                }
                EditorHandoff.Target target = ((EditorHandoff.Accepted) checked).target();
                getActivity().runOnUiThread(() -> {
                    synchronized (state) {
                        if (!state.isCurrent(identity) || android.os.SystemClock.elapsedRealtime() - issuedAt >= 30_000) {
                            call.reject("Editor handoff expired or the session changed", "session_expired"); return;
                        }
                        try {
                            EditorActivity.launch(getActivity(), target, state, identity, issuedAt);
                            call.resolve();
                        } catch (RuntimeException unavailable) {
                            call.reject("Could not open the editor view", "unavailable");
                        }
                    }
                });
            } catch (RemoteTransport.AccessDenied denied) {
                synchronized (state) { if (state.isCurrent(identity)) NotificationIdentity.replace(getContext(), "", ""); }
                call.reject("Editor session ended", "session_expired");
            } catch (java.io.IOException unavailable) {
                call.reject("Could not read your editor configuration", "disconnected");
            }
        });
    }

    @PluginMethod
    public void syncSession(PluginCall call) {
        try {
            if (NotificationIdentity.replace(getContext(), call.getString("user", ""), call.getString("session", ""))) {
                getContext().getSharedPreferences("write-settings", 0).edit().remove("environment").apply();
                for (String key : new String[] { "environment", "sessionId", "user" }) getActivity().getIntent().removeExtra(key);
                if (NotificationIdentity.get(getContext()).current() != null
                    && getContext().getSharedPreferences("notification-settings", 0).getBoolean("enabled", false)) {
                    startNotifications();
                } else getContext().stopService(new Intent(getContext(), IdleNotificationService.class));
            }
            call.resolve();
        } catch (IllegalArgumentException failure) { call.reject(failure.getMessage(), failure); }
    }

    static boolean granted(PermissionState state) {
        return switch (state) {
            case GRANTED -> true;
            case DENIED, PROMPT, PROMPT_WITH_RATIONALE -> false;
        };
    }

    static boolean requiresPhoneSettings(PermissionState state) {
        return switch (state) {
            case GRANTED, DENIED -> true;
            case PROMPT, PROMPT_WITH_RATIONALE -> false;
        };
    }

    @PluginMethod
    public void writeStatus(PluginCall call) {
        call.resolve(new JSObject()
            .put("microphone", granted(getPermissionState("microphone")))
            .put("notification", NativeAccess.notifications(getContext()))
            .put("overlay", Settings.canDrawOverlays(getContext()))
            .put("accessibility", NativeAccess.accessibility(getContext(), WriteAccessibilityService.class))
            .put("battery", ((android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE))
                .isIgnoringBatteryOptimizations(getContext().getPackageName()))
            .put("keyboardRequired", getContext().getSharedPreferences("write-settings", 0).getBoolean("keyboardRequired", true))
            .put("overlayEnabled", getContext().getSharedPreferences("write-settings", 0).getBoolean("overlayEnabled", true)));
    }

    @PluginMethod
    public void writeSetup(PluginCall call) {
        NativeState.WriteSetup step;
        try { step = NativeState.require(NativeState.WriteSetup.class, call.getString("step", "")); }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage(), "invalid_args"); return; }
        Runnable setup = switch (step) {
            case MICROPHONE -> () -> {
                if (granted(getPermissionState("microphone"))) call.resolve();
                else requestPermissionForAlias("microphone", call, "writeMicrophonePermission");
            };
            case NOTIFICATION -> () -> {
                if (Build.VERSION.SDK_INT < 33 || granted(getPermissionState("notifications"))) call.resolve();
                else requestPermissionForAlias("notifications", call, "writeMicrophonePermission");
            };
            case OVERLAY -> () -> {
                getContext().startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve();
            };
            case ACCESSIBILITY -> () -> {
                getContext().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve();
            };
            case BATTERY -> () -> {
                getContext().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve();
            };
            case ENABLED -> () -> {
                Object enabled = call.getData().opt("enabled");
                if (!(enabled instanceof Boolean)) { call.reject("Write enabled must be a boolean"); return; }
                getContext().getSharedPreferences("write-settings", 0).edit().putBoolean("overlayEnabled", (Boolean) enabled).apply();
                WriteAccessibilityService.settingsChanged();
                call.resolve();
            };
            case KEYBOARD -> () -> {
                boolean required = Boolean.TRUE.equals(call.getBoolean("required", true));
                getContext().getSharedPreferences("write-settings", 0).edit().putBoolean("keyboardRequired", required).apply();
                WriteAccessibilityService.settingsChanged();
                call.resolve();
            };
        };
        setup.run();
    }

    @PermissionCallback
    private void writeMicrophonePermission(PluginCall call) { call.resolve(); }

    @PluginMethod
    public void writeEnvironment(PluginCall call) {
        String user = call.getString("user", "");
        String environment = call.getString("environment", "");
        RemoteSession.Identity identity = NotificationIdentity.get(getContext()).current();
        if (identity == null || !identity.user.equals(user) || environment.isBlank()) {
            call.reject("Write environment needs an authenticated selection"); return;
        }
        getContext().getSharedPreferences("write-settings", 0).edit().putString("environment", environment).apply();
        call.resolve();
    }

    @PluginMethod
    public void phoneStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(PhoneControlService.status(getContext()))); }
        catch (org.json.JSONException failure) { call.reject("Could not read phone status", "internal_error", failure); }
    }

    @PluginMethod
    public void phoneOverlay(PluginCall call) {
        Boolean visible = call.getBoolean("visible");
        if (visible == null) { call.reject("visible must be a boolean", "invalid_args"); return; }
        getActivity().runOnUiThread(() -> {
            KenanOverlay.setVisible(getContext(), visible); phoneStatus(call);
        });
    }

    @PluginMethod
    public void phoneConfigure(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("enabled", false))) {
            PhoneControlService.disable(getContext()); phoneStatus(call); return;
        }
        RemoteSession state = NotificationIdentity.get(getContext());
        RemoteSession.Identity identity = state.current();
        String user = call.getString("user", "");
        String environment = call.getString("environment", "");
        String name = call.getString("name", PhoneControlService.settings(getContext()).getString("name", Build.MODEL));
        if (identity == null || !identity.user.equals(user) || environment.isBlank() || name.isBlank() || name.length() > 256) {
            call.reject("Phone control needs a matching authenticated person, permitted environment and name", "invalid_args"); return;
        }
        updateExecutor.execute(() -> {
            try {
                boolean permitted = false;
                for (RemoteEnvironment.Endpoint endpoint : RemoteEnvironment.parse(RouterConnection.routerUrl(),
                    RemoteTransport.get(RouterConnection.routerUrl() + "/v1/environments", identity))) {
                    if (endpoint.id.equals(environment)) permitted = true;
                }
                synchronized (state) {
                    if (!state.isCurrent(identity)) { call.reject("Session changed before enabling phone control", "session_expired"); return; }
                    if (!permitted) { call.reject("Environment is not permitted for this session", "permission_denied"); return; }
                    PhoneControlService.settings(getContext()).edit().putBoolean("enabled", true).putString("user", user)
                        .putString("environment", environment).putString("name", name).apply();
                    PhoneControlService.start(getContext());
                    phoneStatus(call);
                }
            } catch (RemoteTransport.AccessDenied denied) {
                synchronized (state) { if (state.isCurrent(identity)) NotificationIdentity.replace(getContext(), "", ""); }
                call.reject(denied.getMessage(), "session_expired");
            } catch (Exception failure) { call.reject("Could not enable phone control: " + failure.getMessage(), "disconnected", failure); }
        });
    }

    @PluginMethod
    public void phoneSetup(PluginCall call) {
        NativeState.PhoneSetup parsed;
        try { parsed = NativeState.require(NativeState.PhoneSetup.class, call.getString("step", "")); }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage(), "invalid_args"); return; }
        String step = parsed.wire();
        if (!requestingPhoneAccess.compareAndSet(false, true)) {
            call.reject("Return from the current phone access request first", "busy"); return;
        }
        try {
            if (PhoneControlService.capabilities(getContext()).optBoolean(step)) {
                finishPhoneAccess(call); return;
            }
            Runnable setup = switch (parsed) {
                case CONTACTS, CALENDAR, LOCATION, BACKGROUND_LOCATION, SMS, CALL_LOG, PHONE, CAMERA, MICROPHONE, NOTIFICATIONS -> () -> {
                    if (step.equals("notifications") && Build.VERSION.SDK_INT < 33) {
                        openPhoneSettings(call, new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())); return;
                    }
                    if (step.equals("backgroundLocation") && Build.VERSION.SDK_INT < 29) { finishPhoneAccess(call); return; }
                    if (step.equals("backgroundLocation")) {
                        boolean locationGranted = androidx.core.content.ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED
                            || androidx.core.content.ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED;
                        if (!locationGranted) { requestingPhoneAccess.set(false); call.reject("Approve location before background location", "permission_denied"); return; }
                        if (Build.VERSION.SDK_INT >= 30 && !granted(getPermissionState("backgroundLocation"))) {
                            openPhoneSettings(call, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()))); return;
                        }
                    }
                    if (requiresPhoneSettings(getPermissionState(step))) {
                        openPhoneSettings(call, new Intent(step.equals("notifications") ? Settings.ACTION_APP_NOTIFICATION_SETTINGS : Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            step.equals("notifications") ? null : Uri.parse("package:" + getContext().getPackageName()))
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName()));
                    } else requestPermissionForAlias(step, call, "phonePermission");
                    return;
                };
                case ACCESSIBILITY, WRITE_ACCESSIBILITY -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    .putExtra(Intent.EXTRA_COMPONENT_NAME, new android.content.ComponentName(getContext(),
                        step.equals("writeAccessibility") ? WriteAccessibilityService.class : PhoneAccessibilityService.class).flattenToString()));
                case NOTIFICATION_ACCESS -> () -> openPhoneSettings(call, new Intent(Build.VERSION.SDK_INT >= 30 ? Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS : Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, new android.content.ComponentName(getContext(), PhoneNotificationService.class).flattenToString()));
                case OVERLAY -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())));
                case BATTERY -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName())));
                case ALL_FILES -> () -> {
                    if (Build.VERSION.SDK_INT < 30) { requestingPhoneAccess.set(false); call.reject("All-files access requires Android 11 or newer; app-owned files remain available", "unsupported"); return; }
                    openPhoneSettings(call, new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName())));
                };
                case USAGE -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
                case WRITE_SETTINGS -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
                case INSTALL_PACKAGES -> () -> openPhoneSettings(call, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())));
                case DEVICE_ADMIN -> () -> openPhoneSettings(call, new Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN, new android.content.ComponentName(getContext(), PhoneAdminReceiver.class))
                    .putExtra(android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Optional remote screen locking. Factory reset requires separate Device Owner provisioning, not this grant."));
                case DEVICE_OWNER -> () -> { requestingPhoneAccess.set(false); call.reject("Device Owner requires separate Android enterprise provisioning, not a settings toggle. Phone control works without it.", "unsupported"); return; };
                case SECURE_SETTINGS -> () -> { requestingPhoneAccess.set(false); call.reject("Secure settings requires an optional shell grant or system provisioning, not a settings toggle. Phone control works without it.", "unsupported"); return; };
            };
            setup.run();
        } catch (Exception failure) { requestingPhoneAccess.set(false); call.reject("Could not open phone setup: " + failure.getMessage(), "unavailable", failure); }
    }

    private void openPhoneSettings(PluginCall call, Intent intent) {
        startActivityForResult(call, intent, "phoneSettingsReturned");
        String instruction = call.getString("instruction", "");
        if (!instruction.isBlank()) android.widget.Toast.makeText(getContext(),
            instruction.substring(0, Math.min(instruction.length(), 240)), android.widget.Toast.LENGTH_LONG).show();
    }
    @ActivityCallback
    private void phoneSettingsReturned(PluginCall call, ActivityResult result) {
        if (call != null) finishPhoneAccess(call);
        else requestingPhoneAccess.set(false);
    }
    private void finishPhoneAccess(PluginCall call) {
        requestingPhoneAccess.set(false);
        PhoneControlService.refresh();
        phoneStatus(call);
    }
    @PermissionCallback
    private void phonePermission(PluginCall call) { finishPhoneAccess(call); }

    @PluginMethod
    public void checkAppUpdate(PluginCall call) {
        updateExecutor.execute(() -> {
            try {
                AppUpdates.Update update = appUpdates.check(webBundles);
                call.resolve(checkResult(update));
                // Fetch a web bundle in the background so applying it, or the next cold start, is immediate.
                if (update != null && update.kind == NativeState.UpdateKind.WEB && webBundles.installed(update.revision) == null) {
                    try { appUpdates.stageWeb(webBundles); } catch (Exception ignored) { }
                }
            } catch (Exception failure) {
                call.reject("Could not check for an app update. " + failure.getMessage(), failure);
            }
        });
    }

    private JSObject checkResult(AppUpdates.Update update) {
        WebBundles.Installed active = webBundles.active();
        JSObject installed = new JSObject()
            .put("revision", BuildConfig.RELEASE_REVISION)
            .put("versionCode", BuildConfig.VERSION_CODE)
            .put("applicationId", BuildConfig.APPLICATION_ID)
            .put("shellId", BuildConfig.SHELL_ID)
            .put("web", new JSObject()
                .put("revision", active == null ? BuildConfig.RELEASE_REVISION : active.revision)
                .put("versionCode", active == null ? BuildConfig.VERSION_CODE : active.versionCode)
                .put("builtIn", active == null));
        JSObject result = new JSObject().put("installed", installed);
        result.put("update", update == null ? org.json.JSONObject.NULL : new JSObject()
            .put("kind", update.kind.wire()).put("revision", update.revision).put("versionCode", update.versionCode)
            .put("ready", update.kind == NativeState.UpdateKind.WEB && webBundles.installed(update.revision) != null));
        return result;
    }

    @PluginMethod
    public void webReady(PluginCall call) {
        updateExecutor.execute(() -> {
            webBundles.confirmActive();
            call.resolve();
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
                AppUpdates.Update update = appUpdates.check(webBundles);
                if (update == null) { installingUpdate.set(false); call.reject("No app update is available"); return; }
                NativeState.Action install = switch (update.kind) {
                    case WEB -> () -> {
                        WebBundles.Installed bundle = appUpdates.stageWeb(webBundles);
                        getActivity().runOnUiThread(() -> {
                            installingUpdate.set(false);
                            call.resolve(new JSObject().put("status", "reloading").put("revision", bundle.revision));
                            ((MainActivity) getActivity()).serveWebBundle(webBundles.activate());
                        });
                    };
                    case APK -> () -> {
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
                    };
                };
                install.run();
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
        if (call.getData().has("kind") && !(call.getData().opt("kind") instanceof String)) {
            call.reject("Haptic kind must be a string", "invalid_args"); return;
        }
        NativeState.Haptic kind;
        try { kind = NativeState.require(NativeState.Haptic.class, call.getString("kind", "select")); }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage(), "invalid_args"); return; }
        getActivity().runOnUiThread(() -> {
            boolean played = NativeHaptics.play(getActivity().getWindow().getDecorView(), kind.wire());
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
        if (Build.VERSION.SDK_INT >= 33 && !granted(getPermissionState("notifications"))) {
            getContext().getSharedPreferences("notification-settings", 0).edit().putBoolean("enabled", false).apply();
            getContext().stopService(new Intent(getContext(), IdleNotificationService.class));
            if (Boolean.TRUE.equals(call.getBoolean("request", false))) {
                requestPermissionForAlias("notifications", call, "notificationPermission");
            } else call.resolve(new JSObject().put("enabled", false));
            return;
        }
        notificationPermission(call);
    }

    @PermissionCallback
    private void notificationPermission(PluginCall call) {
        boolean granted = NativeAccess.notifications(getContext());
        boolean enabled = granted && NotificationIdentity.get(getContext()).current() != null;
        getContext().getSharedPreferences("notification-settings", 0).edit().putBoolean("enabled", enabled).apply();
        if (enabled) startNotifications();
        else getContext().stopService(new Intent(getContext(), IdleNotificationService.class));
        call.resolve(new JSObject().put("enabled", enabled));
    }

    private void startNotifications() {
        androidx.core.content.ContextCompat.startForegroundService(getContext(), new Intent(getContext(), IdleNotificationService.class));
    }

    @PluginMethod
    public void notificationCursor(PluginCall call) {
        RemoteSession state = NotificationIdentity.get(getContext());
        synchronized (state) {
            if (!notificationCaller(call)) return;
            long after = NotificationDelivery.cursor(getContext(), call.getString("environment"));
            call.resolve(new JSObject().put("after", after < 0 ? org.json.JSONObject.NULL : after));
        }
    }

    @PluginMethod
    public void notificationLease(PluginCall call) {
        RemoteSession state = NotificationIdentity.get(getContext());
        synchronized (state) {
            if (!notificationCaller(call)) return;
            String environment = call.getString("environment");
            String requested = call.getString("state");
            long after = NotificationDelivery.cursor(getContext(), environment);
            boolean accepted;
            if ("healthy".equals(requested)) {
                accepted = getContext().getSharedPreferences("notification-settings", 0).getBoolean("enabled", false)
                    && NativeAccess.notifications(getContext()) && NotificationFeedLease.renew(state.current(), environment, after, android.os.SystemClock.elapsedRealtime());
                if (!accepted) NotificationFeedLease.release(environment);
            } else if ("released".equals(requested)) {
                NotificationFeedLease.release(environment);
                IdleNotificationService.requestPoll();
                accepted = false;
            } else { call.reject("Unknown notification lease state", "invalid_args"); return; }
            call.resolve(new JSObject().put("accepted", accepted).put("after", after < 0 ? org.json.JSONObject.NULL : after));
        }
    }

    private boolean notificationCaller(PluginCall call) {
        RemoteSession.Identity identity = NotificationIdentity.get(getContext()).current();
        String environment = call.getString("environment");
        if (identity == null || !identity.user.equals(call.getString("user")) || !identity.session.equals(call.getString("session"))) {
            call.reject("Notification session changed", "session_expired"); return false;
        }
        if (environment == null || environment.isBlank()) { call.reject("Notification environment is required", "invalid_args"); return false; }
        return true;
    }

    @PluginMethod
    public void notificationFeed(PluginCall call) {
        RemoteSession state = NotificationIdentity.get(getContext());
        synchronized (state) {
            if (!notificationCaller(call)) return;
            RemoteSession.Identity identity = state.current();
            if (!getContext().getSharedPreferences("notification-settings", 0).getBoolean("enabled", false)
                || !NativeAccess.notifications(getContext())) {
                call.resolve();
                return;
            }
            try {
                String environment = call.getString("environment", "");
                String name = call.getString("name", "");
                org.json.JSONObject feed = call.getObject("feed");
                if (environment.isBlank() || name.isBlank() || feed == null) throw new IllegalArgumentException("Invalid notification feed");
                boolean replay = Boolean.TRUE.equals(call.getBoolean("replay"));
                if (replay) {
                    long cursor = NotificationDelivery.cursor(getContext(), environment);
                    Object supplied = call.getData().opt("after");
                    if (supplied != org.json.JSONObject.NULL && (!(supplied instanceof Number)
                        || ((Number) supplied).doubleValue() != ((Number) supplied).longValue())) {
                        call.reject("Replay after must be an integer cursor or null", "invalid_args"); return;
                    }
                    Long origin = supplied == org.json.JSONObject.NULL ? null : ((Number) supplied).longValue();
                    if (!NotificationSequence.canReplay(cursor, origin, feed.getLong("cursor"))) {
                        NotificationFeedLease.release(environment);
                        call.reject("Replay must begin at or before the native cursor", "notification_gap");
                        return;
                    }
                }
                NotificationDelivery.receive(getContext(), identity, environment, name, feed, !replay);
                long after = NotificationDelivery.cursor(getContext(), environment);
                call.resolve(new JSObject().put("after", after < 0 ? org.json.JSONObject.NULL : after));
            } catch (Exception failure) { call.reject("Could not deliver notification feed: " + failure.getMessage(), failure); }
        }
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
    protected void handleOnResume() { PhoneControlService.start(getContext()); PhoneControlService.refresh(); }

    @Override
    protected void handleOnDestroy() {
        updateExecutor.shutdownNow();
    }
}

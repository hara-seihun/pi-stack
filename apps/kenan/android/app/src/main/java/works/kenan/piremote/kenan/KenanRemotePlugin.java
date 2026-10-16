package works.kenan.piremote.kenan;

import android.content.Intent;
import android.os.Build;
import android.net.Uri;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "KenanRemote")
public final class KenanRemotePlugin extends Plugin {
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean installingUpdate = new AtomicBoolean();
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
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).whenSetupComplete(() -> resolveState(call)));
    }

    private void resolveState(PluginCall call) {
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
        if (!PermissionSetup.complete(getContext())) {
            call.reject("Complete all phone permissions before enabling control", "needs_permissions"); return;
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

        boolean granted = NativeAccess.notifications(getContext());
        boolean enabled = granted && PermissionSetup.complete(getContext()) && NotificationIdentity.get(getContext()).current() != null;
        getContext().getSharedPreferences("notification-settings", 0).edit().putBoolean("enabled", enabled).apply();
        if (enabled) startNotifications();
        else getContext().stopService(new Intent(getContext(), IdleNotificationService.class));
        call.resolve(new JSObject().put("enabled", enabled));
    }

    private void startNotifications() {
        if (!PermissionSetup.complete(getContext())) return;
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
            } catch (NotificationDelivery.PermissionRequired missing) {
                NotificationFeedLease.release(call.getString("environment"));
                call.reject(missing.getMessage(), "needs_permissions");
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

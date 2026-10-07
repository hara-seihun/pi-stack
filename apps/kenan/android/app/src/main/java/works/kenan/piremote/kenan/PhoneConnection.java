package works.kenan.piremote.kenan;

import android.content.Context;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

final class PhoneConnection {
    interface Events {
        void opened(PhoneConnection connection);
        void command(PhoneConnection connection, JSONObject frame);
        void overlayAck(PhoneConnection connection, JSONObject frame);
        void closed(PhoneConnection connection, NativeState.PhoneFailure code, String message);
    }
    static final long HEARTBEAT_SECONDS = 25;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder().connectTimeout(7, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).addInterceptor(RouterConnection.interceptor()).build();
    private final Context context;
    private final RemoteSession.Identity identity;
    private final String environment;
    private final BooleanSupplier authorized;
    private final Events events;
    private volatile WebSocket socket;
    private volatile boolean cancelled;
    private volatile long lastAcknowledged;
    private String announcedDevice;
    PhoneConnection(Context context, RemoteSession.Identity identity, String environment, BooleanSupplier authorized, Events events) {
        this.context = context; this.identity = identity; this.environment = environment; this.authorized = authorized; this.events = events;
    }
    void connect() {
        if (!valid()) return;
        try {
            JSONObject permitted = RemoteTransport.get(RouterConnection.routerUrl() + "/v1/environments", identity);
            String base = null;
            for (RemoteEnvironment.Endpoint candidate : RemoteEnvironment.parse(RouterConnection.routerUrl(), permitted)) {
                if (candidate.id.equals(environment)) base = candidate.baseUrl;
            }
            if (base == null) { fail(NativeState.PhoneFailure.PERMISSION_DENIED, "Chosen environment is no longer permitted"); return; }
            if (!valid()) return;
            Request request = new Request.Builder().url(base.replaceFirst("^http", "ws") + "/v1/phones/connect")
                .header("x-pi-remote-user", identity.user).header("x-pi-remote-session", identity.session).build();
            synchronized (this) {
                if (cancelled) return;
                socket = CLIENT.newWebSocket(request, new WebSocketListener() {
                    @Override public void onOpen(WebSocket ws, Response response) {
                        if (!valid()) { ws.cancel(); return; }
                        lastAcknowledged = android.os.SystemClock.elapsedRealtime();
                        if (!announceChanges()) { fail(NativeState.PhoneFailure.DISCONNECTED, "Could not announce phone"); return; }
                        events.opened(PhoneConnection.this);
                    }
                    @Override public void onMessage(WebSocket ws, String message) {
                        if (!valid()) return;
                        try {
                            JSONObject frame = new JSONObject(message);
                            boolean handled = switch (NativeState.require(NativeState.PhoneFrame.class, frame.getString("type"))) {
                                case COMMAND -> { events.command(PhoneConnection.this, frame); yield true; }
                                case OVERLAY_ACK -> { events.overlayAck(PhoneConnection.this, frame); yield true; }
                                case READY -> { lastAcknowledged = android.os.SystemClock.elapsedRealtime(); yield true; }
                            };
                        } catch (Exception invalid) { fail(NativeState.PhoneFailure.PROTOCOL_ERROR, "Malformed phone command"); }
                    }
                    @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                        int status = response == null ? 0 : response.code();
                        if (response != null && RouterConnection.publicUrl(response.request().url().toString()) && RouterConnection.rejected(status)) {
                            fail(NativeState.PhoneFailure.PUBLIC_SIGN_IN_REQUIRED, "Email sign-in expired. Open Kenan to sign in again"); return;
                        }
                        fail(status == 401 || status == 403 || status == 423 ? NativeState.PhoneFailure.SESSION_EXPIRED : NativeState.PhoneFailure.DISCONNECTED,
                            status == 401 || status == 403 || status == 423 ? "Open Kenan to unlock again" : "Phone connection unavailable: " + error.getMessage());
                    }
                    @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, reason); }
                    @Override public void onClosed(WebSocket ws, int code, String reason) { fail(NativeState.PhoneFailure.DISCONNECTED, "Phone connection closed: " + reason); }
                });
            }
        } catch (RemoteTransport.PublicSignInRequired denied) { fail(NativeState.PhoneFailure.PUBLIC_SIGN_IN_REQUIRED, denied.getMessage()); }
        catch (RemoteTransport.AccessDenied denied) { fail(NativeState.PhoneFailure.SESSION_EXPIRED, denied.getMessage()); }
        catch (Exception failure) { fail(NativeState.PhoneFailure.DISCONNECTED, "Phone discovery failed: " + failure.getMessage()); }
    }
    boolean valid() { return !cancelled && NotificationIdentity.get(context).isCurrent(identity) && authorized.getAsBoolean(); }
    synchronized boolean announceChanges() {
        if (!valid()) return false;
        try {
            JSONObject device = PhoneControlService.device(context);
            String serialized = device.toString();
            if (serialized.equals(announcedDevice)) return true;
            if (!send(new JSONObject().put("type", "hello").put("device", device))) {
                fail(NativeState.PhoneFailure.DISCONNECTED, "Could not announce phone status"); return false;
            }
            announcedDevice = serialized;
            return true;
        } catch (Exception failure) { fail(NativeState.PhoneFailure.INTERNAL_ERROR, "Could not build phone status"); return false; }
    }
    void heartbeat() {
        if (!valid()) return;
        if (android.os.SystemClock.elapsedRealtime() - lastAcknowledged >= 40_000) {
            fail(NativeState.PhoneFailure.DISCONNECTED, "Phone heartbeat was not acknowledged"); return;
        }
        try {
            if (!send(new JSONObject().put("type", "heartbeat"))) fail(NativeState.PhoneFailure.DISCONNECTED, "Could not send phone heartbeat");
        } catch (org.json.JSONException defect) { throw new IllegalStateException(defect); }
    }
    boolean send(JSONObject frame) { WebSocket active = socket; return valid() && active != null && active.queueSize() < 24 * 1024 * 1024 && active.send(frame.toString()); }
    private void fail(NativeState.PhoneFailure code, String message) {
        synchronized (this) { if (cancelled) return; cancelled = true; if (socket != null) socket.cancel(); }
        events.closed(this, code, message);
    }
    synchronized void close() { cancelled = true; if (socket != null) socket.cancel(); }
}

package works.kenan.piremote.kenan;

import android.content.Context;
import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONException;
import org.json.JSONObject;

/** The sole client ⇄ supervisor protocol adapter. Neither the UI nor recorder knows its wire format. */
final class WriteConnection {
    interface Events {
        void connected();
        void partial(String text);
        void finished(String text);
        default void notice(String message) { }
        void failed(String message);
    }

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .connectTimeout(7, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false)
        .addInterceptor(RouterConnection.interceptor()).build();
    private final Context context;
    private final RemoteSession state;
    private final RemoteSession.Identity identity;
    private final Events events;
    interface EndpointLookup { String get() throws IOException; }
    interface Sockets { WebSocket open(Request request, WebSocketListener listener); }
    private final EndpointLookup lookup;
    private final java.util.function.BooleanSupplier current;
    private final Sockets sockets;
    private WebSocket socket;
    private boolean started;
    private boolean closed;
    private boolean finishing;
    private boolean terminal;

    WriteConnection(Context context, RemoteSession.Identity identity, Events events) {
        this.context = context.getApplicationContext();
        this.state = NotificationIdentity.get(context);
        this.identity = identity;
        this.events = events;
        this.lookup = this::endpoint;
        this.current = () -> state.isCurrent(identity);
        this.sockets = CLIENT::newWebSocket;
    }

    WriteConnection(RemoteSession.Identity identity, Events events, EndpointLookup lookup,
                    java.util.function.BooleanSupplier current, Sockets sockets) {
        this.context = null;
        this.state = null;
        this.identity = identity;
        this.events = events;
        this.lookup = lookup;
        this.current = current;
        this.sockets = sockets;
    }

    private String endpoint() throws IOException {
        JSONObject response = RemoteTransport.get(RouterConnection.routerUrl() + "/v1/environments", identity);
        List<RemoteEnvironment.Endpoint> endpoints;
        try { endpoints = RemoteEnvironment.parse(RouterConnection.routerUrl(), response); }
        catch (JSONException | IllegalArgumentException error) { throw new IOException("Invalid environment list", error); }
        String chosen = context.getSharedPreferences("write-settings", 0).getString("environment", "");
        for (RemoteEnvironment.Endpoint candidate : endpoints) if (candidate.id.equals(chosen)) return candidate.baseUrl;
        if (!endpoints.isEmpty()) return endpoints.get(0).baseUrl;
        throw new IOException("No permitted Pi Remote environment");
    }

    void connect(String contextText) {
        synchronized (this) {
            if (closed || started) return;
            started = true;
        }
        new Thread(() -> {
            try {
                String base = lookup.get();
                synchronized (this) {
                    if (closed || !current.getAsBoolean()) { cancel(); return; }
                    String url = base.replaceFirst("^http", "ws") + "/v1/write/stream?session="
                        + java.net.URLEncoder.encode(identity.session, java.nio.charset.StandardCharsets.UTF_8);
                    Request request = new Request.Builder().url(url).header("x-pi-remote-user", identity.user)
                        .header("x-pi-remote-session", identity.session).build();
                    socket = sockets.open(request, new WebSocketListener() {
                        @Override public void onOpen(WebSocket webSocket, Response response) {
                            if (!valid(webSocket)) { cancel(); return; }
                            try {
                                JSONObject start = new JSONObject().put("type", "start")
                                    .put("dictation", UUID.randomUUID().toString()).put("context", contextText)
                                    .put("audio", "opus");
                                if (!webSocket.send(start.toString())) throw new IOException("Could not start dictation");
                                events.connected();
                            } catch (IOException | JSONException error) { fail(error.getMessage()); }
                        }
                        @Override public void onMessage(WebSocket webSocket, String message) {
                            if (!valid(webSocket)) { cancel(); return; }
                            try {
                                JSONObject event = new JSONObject(message);
                                NativeState.WriteEvent type = NativeState.require(NativeState.WriteEvent.class, event.getString("type"));
                                boolean handled = switch (type) {
                                    case PARTIAL -> {
                                        events.partial(event.getString("committed") + event.getString("tail"));
                                        yield true;
                                    }
                                    case FINAL -> {
                                        String text = event.getString("text");
                                        Object rewrite = event.opt("rewrite");
                                        if (rewrite != null && rewrite != JSONObject.NULL && !(rewrite instanceof JSONObject))
                                            throw new JSONException("Rewrite metadata must be an object or null");
                                        String notice = rewriteNotice(rewrite instanceof JSONObject ? (JSONObject) rewrite : null);
                                        if (terminate(true)) {
                                            if (notice != null) events.notice(notice);
                                            events.finished(text);
                                        }
                                        yield true;
                                    }
                                    case ERROR -> {
                                        fail(event.optString("message", "Recognition failed"));
                                        yield true;
                                    }
                                };
                            } catch (JSONException | IllegalArgumentException error) { fail("Invalid dictation response: " + error.getMessage()); }
                        }
                        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                            try {
                                if (valid(webSocket)) fail(response != null && RouterConnection.publicUrl(response.request().url().toString()) && RouterConnection.rejected(response.code())
                                    ? "Email sign-in expired. Open Kenan to sign in again."
                                    : response != null && response.code() == 423 ? "Session expired. Open Kenan to unlock."
                                    : "Write server unreachable: " + error.getMessage());
                                else cancel();
                            } finally { if (response != null && response.body() != null) response.close(); }
                        }
                        @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                            if (valid(webSocket)) fail("Dictation connection closed before final text: " + reason);
                            else cancel();
                        }
                        @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                            if (valid(webSocket)) fail("Dictation connection closed before final text: " + reason);
                        }
                    });
                }
            } catch (IOException | RuntimeException error) { fail("Write server unreachable: " + error.getMessage()); }
        }, "write-connect").start();
    }

    static String rewriteNotice(JSONObject rewrite) throws JSONException {
        if (rewrite == null) return null;
        return switch (NativeState.require(NativeState.RewriteStatus.class, rewrite.getString("status"))) {
            case APPLIED, UNCHANGED -> null;
            case GUARDED -> "Kept the original wording to avoid changing its meaning.";
            case UNAVAILABLE -> switch (NativeState.require(NativeState.UnavailableRewrite.class, rewrite.getString("reason"))) {
                case WARMING -> "Local rewrite is warming up; inserted the transcript.";
                case WARMUP_FAILED, QUEUE_BUSY, RUNTIME_CLOSED, INFERENCE_FAILED -> "Local rewrite unavailable; inserted the transcript.";
            };
        };
    }

    private synchronized boolean valid(WebSocket candidate) {
        return !closed && socket == candidate && current.getAsBoolean();
    }
    private void fail(String message) { if (terminate(true)) events.failed(message); }
    private synchronized boolean terminate(boolean notify) {
        if (closed) return false;
        closed = true;
        terminal = notify && current.getAsBoolean();
        WebSocket previous = socket;
        socket = null;
        // A graceful close can keep the dispatcher and native socket alive for 60 seconds.
        if (previous != null) previous.cancel();
        return terminal;
    }
    synchronized boolean audio(byte[] packet) {
        if (!current.getAsBoolean()) { cancel(); return false; }
        return !closed && !finishing && socket != null && socket.queueSize() < 10_000
            && socket.send(ByteString.of(packet));
    }
    synchronized long queueSize() { return socket == null ? 0 : socket.queueSize(); }
    synchronized boolean ended() { return terminal; }
    synchronized void finish() {
        if (!current.getAsBoolean()) { cancel(); return; }
        if (socket == null || closed || finishing) return;
        finishing = true;
        if (!socket.send("{\"type\":\"finish\"}")) fail("Could not finish dictation");
    }
    void cancel() { terminate(false); }

    record Learned(String word, String undoId) {}
    static void learn(Context context, RemoteSession.Identity identity, WriteText.Correction correction,
                      java.util.function.Consumer<Learned> done) {
        request(context, identity, "/v1/write/learn", correction, null, done);
    }
    static void undo(Context context, RemoteSession.Identity identity, String undoId,
                     java.util.function.Consumer<Learned> done) {
        request(context, identity, "/v1/write/undo", null, undoId, done);
    }
    private static void request(Context context, RemoteSession.Identity identity, String path,
                                WriteText.Correction correction, String undoId, java.util.function.Consumer<Learned> done) {
        new Thread(() -> {
            try {
                WriteConnection helper = new WriteConnection(context, identity, new Events() {
                    public void connected() {} public void partial(String text) {}
                    public void finished(String text) {} public void failed(String error) {}
                });
                String base = helper.endpoint();
                JSONObject body = undoId != null ? new JSONObject().put("undoId", undoId)
                    : new JSONObject().put("inserted", correction.inserted()).put("final", correction.replacement());
                Request request = new Request.Builder().url(base + path).header("x-pi-remote-user", identity.user)
                    .header("x-pi-remote-session", identity.session)
                    .post(RequestBody.create(body.toString(), MediaType.get("application/json"))).build();
                try (Response response = CLIENT.newCall(request).execute()) {
                    if (!helper.state.isCurrent(identity)) return;
                    if (!response.isSuccessful()) throw new IOException("HTTP " + response.code());
                    JSONObject result = new JSONObject(response.body().string());
                    done.accept(new Learned(correction == null ? "" : correction.replacement(),
                        result.optString("undoId", "")));
                }
            } catch (Exception error) { done.accept(null); }
        }, "write-learning").start();
    }
}

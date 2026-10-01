package works.kenan.piremote.kenan;

import android.content.Context;
import android.util.Log;
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
        void failed(String message);
    }

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .connectTimeout(7, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false)
        .addInterceptor(chain -> {
            Request request = chain.request();
            if (RouterConnection.publicUrl(request.url().toString()) && !RouterConnection.token().isEmpty()) {
                request = request.newBuilder().header("cf-access-token", RouterConnection.token()).build();
            }
            Response response = chain.proceed(request);
            RouterConnection.reject(request.url().toString(), response.code(), request.header("cf-access-token") == null ? "" : request.header("cf-access-token"));
            return response;
        }).build();
    private final Context context;
    private final RemoteSession state;
    private final RemoteSession.Identity identity;
    private final Events events;
    private WebSocket socket;
    private String endpoint;
    private boolean closed;

    WriteConnection(Context context, RemoteSession.Identity identity, Events events) {
        this.context = context.getApplicationContext();
        this.state = NotificationIdentity.get(context);
        this.identity = identity;
        this.events = events;
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
        new Thread(() -> {
            try {
                String base = endpoint();
                synchronized (this) {
                    if (closed || !state.isCurrent(identity)) return;
                    endpoint = base;
                    String url = base.replaceFirst("^http", "ws") + "/v1/write/stream?session="
                        + java.net.URLEncoder.encode(identity.session, java.nio.charset.StandardCharsets.UTF_8);
                    Request request = new Request.Builder().url(url).header("x-pi-remote-user", identity.user)
                        .header("x-pi-remote-session", identity.session).build();
                    socket = CLIENT.newWebSocket(request, new WebSocketListener() {
                        private boolean terminal;
                        @Override public void onOpen(WebSocket webSocket, Response response) {
                            if (!valid()) { webSocket.close(1000, "Session changed"); return; }
                            try {
                                JSONObject start = new JSONObject().put("type", "start")
                                    .put("dictation", UUID.randomUUID().toString()).put("context", contextText)
                                    .put("audio", "opus");
                                if (!webSocket.send(start.toString())) throw new IOException("Could not start dictation");
                                events.connected();
                            } catch (Exception error) { events.failed(error.getMessage()); webSocket.cancel(); }
                        }
                        @Override public void onMessage(WebSocket webSocket, String message) {
                            if (!valid()) return;
                            try {
                                JSONObject event = new JSONObject(message);
                                switch (event.getString("type")) {
                                    case "partial" -> events.partial(event.optString("committed") + event.optString("tail"));
                                    case "final" -> { terminal = true; events.finished(event.getString("text")); webSocket.close(1000, "Done"); }
                                    case "error" -> { terminal = true; events.failed(event.optString("message", "Recognition failed")); }
                                    default -> { }
                                }
                            } catch (JSONException error) { events.failed("Invalid dictation response"); }
                        }
                        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                            if (valid() && !terminal) events.failed(response != null && RouterConnection.publicUrl(response.request().url().toString()) && RouterConnection.rejected(response.code())
                                ? "Email sign-in expired. Open Kenan to sign in again."
                                : response != null && response.code() == 423 ? "Session expired. Open Kenan to unlock."
                                : "Write server unreachable: " + error.getMessage());
                        }
                        @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                            if (valid() && !terminal) events.failed("Dictation connection closed before final text: " + reason);
                        }
                    });
                }
            } catch (IOException error) { if (valid()) events.failed("Write server unreachable: " + error.getMessage()); }
        }, "write-connect").start();
    }

    private synchronized boolean valid() { return !closed && state.isCurrent(identity); }
    synchronized boolean audio(byte[] packet) {
        return !closed && socket != null && socket.queueSize() < 10_000
            && socket.send(ByteString.of(packet));
    }
    synchronized long queueSize() { return socket == null ? 0 : socket.queueSize(); }
    synchronized void finish() {
        if (socket == null || closed) return;
        Log.i("PiStackWrite", "Opus queue at finish: " + socket.queueSize() + " bytes");
        if (!socket.send("{\"type\":\"finish\"}")) events.failed("Could not finish dictation");
    }
    synchronized void cancel() {
        if (closed) return;
        closed = true;
        if (socket != null) { socket.send("{\"type\":\"cancel\"}"); socket.close(1000, "Cancelled"); }
    }

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

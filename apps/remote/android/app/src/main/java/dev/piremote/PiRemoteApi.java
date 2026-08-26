package dev.piremote;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** The Android app's single HTTP boundary to every configured Pi Remote environment. */
final class PiRemoteApi {
    private static final Set<String> VERIFIED = ConcurrentHashMap.newKeySet();

    private PiRemoteApi() {}

    static JSONObject get(String path) throws Exception {
        return request("GET", path, null);
    }

    static JSONObject getFor(String environmentId, String path) throws Exception {
        return requestFor(PiRemoteEnvironment.find(environmentId), "GET", path, null);
    }

    static JSONObject request(String method, String path, JSONObject body) throws Exception {
        return request(method, path, body, null);
    }

    static JSONObject request(String method, String path, JSONObject body, Cancellation cancellation) throws Exception {
        PiRemoteEnvironment.Endpoint environment = PiRemoteEnvironment.current();
        verify(environment, cancellation);
        JSONObject result;
        try {
            result = send(environment, method, path, body, cancellation);
        } catch (Locked locked) {
            if (!environment.requiresUnlock) throw locked;
            PiRemoteKey.ensureUnlocked(environment);
            result = send(environment, method, path, body, cancellation);
        }
        if (!environment.id.equals(PiRemoteEnvironment.current().id)) throw new StaleEnvironment(environment.id);
        return result;
    }

    static JSONObject requestFor(PiRemoteEnvironment.Endpoint environment, String method, String path, JSONObject body) throws Exception {
        verify(environment);
        try {
            return send(environment, method, path, body);
        } catch (Locked locked) {
            if (!environment.requiresUnlock) throw locked;
            PiRemoteKey.ensureUnlocked(environment);
            return send(environment, method, path, body);
        }
    }

    static JSONObject unlockRequest(PiRemoteEnvironment.Endpoint environment, JSONObject body) throws Exception {
        return send(environment, "POST", "/v1/unlock", body);
    }

    static JSONObject putBytes(String path, byte[] data, String sha256) throws Exception {
        PiRemoteEnvironment.Endpoint environment = PiRemoteEnvironment.current();
        verify(environment);
        PiRemoteTransport.ensure(environment);
        HttpURLConnection connection = (HttpURLConnection) new URL(environment.baseUrl + path).openConnection();
        try {
            connection.setRequestMethod("PUT");
            connection.setDoOutput(true);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setRequestProperty("X-Chunk-Sha256", sha256);
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(data); }
            int status = connection.getResponseCode();
            String value = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            JSONObject result = value.isEmpty() ? new JSONObject() : new JSONObject(value);
            if (status == 423) throw new Locked(result.optString("error", "Locked"));
            if (status < 200 || status >= 300) throw new HttpFailure(status, result.optString("error", "HTTP " + status));
            return result;
        } catch (IOException failure) {
            if (!(failure instanceof SocketTimeoutException)) PiRemoteTransport.invalidate(environment);
            throw failure;
        } finally { connection.disconnect(); }
    }

    static JSONObject upload(String path, InputStream input, String contentType) throws Exception {
        PiRemoteEnvironment.Endpoint environment = PiRemoteEnvironment.current();
        verify(environment);
        try {
            PiRemoteTransport.ensure(environment);
            HttpURLConnection connection = (HttpURLConnection) new URL(environment.baseUrl + path).openConnection();
            try {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(120_000);
                connection.setChunkedStreamingMode(64 * 1024);
                connection.setRequestProperty("Content-Type", contentType);
                try (input; OutputStream output = connection.getOutputStream()) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int count; (count = input.read(buffer)) >= 0;)
                        if (count > 0) output.write(buffer, 0, count);
                }
                int status = connection.getResponseCode();
                String value = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
                JSONObject result = value.isEmpty() ? new JSONObject() : new JSONObject(value);
                if (status == 423) throw new Locked(result.optString("error", "Locked"));
                if (status < 200 || status >= 300)
                    throw new HttpFailure(status, result.optString("error", "HTTP " + status));
                if (!environment.id.equals(PiRemoteEnvironment.current().id))
                    throw new StaleEnvironment(environment.id);
                return result;
            } finally {
                connection.disconnect();
            }
        } catch (Locked | StaleEnvironment | HttpFailure failure) {
            throw failure;
        } catch (IOException failure) {
            if (!(failure instanceof SocketTimeoutException)) PiRemoteTransport.invalidate(environment);
            throw failure;
        }
    }

    private static void verify(PiRemoteEnvironment.Endpoint environment) throws Exception {
        verify(environment, null);
    }

    private static void verify(PiRemoteEnvironment.Endpoint environment, Cancellation cancellation) throws Exception {
        if (VERIFIED.contains(environment.id)) return;
        JSONObject metadata = send(environment, "GET", "/v1/environment", null, cancellation).optJSONObject("environment");
        String actual = metadata == null ? "" : metadata.optString("id");
        if (!environment.id.equals(actual))
            throw new IOException("Expected " + environment.id + " but endpoint reported " + (actual.isEmpty() ? "no environment identity" : actual));
        VERIFIED.add(environment.id);
    }

    static final class Cancellation {
        private HttpURLConnection active;
        private boolean cancelled;

        synchronized boolean attach(HttpURLConnection connection) {
            if (cancelled) return false;
            active = connection;
            return true;
        }

        synchronized void detach(HttpURLConnection connection) {
            if (active == connection) active = null;
        }

        synchronized void cancel() {
            cancelled = true;
            if (active != null) active.disconnect();
            active = null;
        }

        synchronized boolean isCancelled() { return cancelled; }
    }

    static final class Cancelled extends IOException {
        Cancelled() { super("Request cancelled"); }
    }

    static final class Locked extends IOException {
        Locked(String message) { super(message); }
    }

    static final class StaleEnvironment extends IOException {
        StaleEnvironment(String id) { super("Environment changed while requesting " + id); }
    }

    static final class HttpFailure extends IOException {
        final int status;
        HttpFailure(int status, String message) { super(message); this.status = status; }
        boolean retryable() { return status == 408 || status == 425 || status == 429 || status >= 500; }
    }

    private static JSONObject send(PiRemoteEnvironment.Endpoint environment, String method, String path, JSONObject body) throws Exception {
        return send(environment, method, path, body, null);
    }

    private static JSONObject send(PiRemoteEnvironment.Endpoint environment, String method, String path, JSONObject body,
                                   Cancellation cancellation) throws Exception {
        HttpURLConnection connection = null;
        try {
            PiRemoteTransport.ensure(environment);
            connection = (HttpURLConnection) new URL(environment.baseUrl + path).openConnection();
            if (cancellation != null && !cancellation.attach(connection)) {
                connection.disconnect();
                throw new Cancelled();
            }
            try {
                connection.setRequestMethod(method);
                connection.setConnectTimeout(7_000);
                connection.setReadTimeout(path.equals("/v1/sync") ? 40_000 : 20_000);
                connection.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setFixedLengthStreamingMode(data.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(data); }
                }
                int status = connection.getResponseCode();
                String value = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
                JSONObject result = value.isEmpty() ? new JSONObject() : new JSONObject(value);
                if (status == 423) throw new Locked(result.optString("error", "Locked"));
                if (status < 200 || status >= 300)
                    throw new HttpFailure(status, result.optString("error", "HTTP " + status));
                return result;
            } finally {
                if (cancellation != null) cancellation.detach(connection);
                connection.disconnect();
            }
        } catch (Locked | HttpFailure | Cancelled failure) {
            throw failure;
        } catch (IOException failure) {
            if (cancellation != null && cancellation.isCancelled()) throw new Cancelled();
            if (!(failure instanceof SocketTimeoutException)) PiRemoteTransport.invalidate(environment);
            throw failure;
        }
    }

    static String read(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            for (int count; (count = input.read(buffer)) >= 0;) output.write(buffer, 0, count);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}

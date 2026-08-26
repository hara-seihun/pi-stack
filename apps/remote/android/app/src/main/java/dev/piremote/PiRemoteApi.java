package dev.piremote;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
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
        PiRemoteEnvironment.Endpoint environment = PiRemoteEnvironment.current();
        JSONObject result = requestFor(environment, method, path, body);
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

    private static void verify(PiRemoteEnvironment.Endpoint environment) throws Exception {
        if (VERIFIED.contains(environment.id)) return;
        JSONObject metadata = send(environment, "GET", "/v1/environment", null).optJSONObject("environment");
        String actual = metadata == null ? "" : metadata.optString("id");
        if (!environment.id.equals(actual))
            throw new IOException("Expected " + environment.id + " but endpoint reported " + (actual.isEmpty() ? "no environment identity" : actual));
        VERIFIED.add(environment.id);
    }

    static String absolute(String path) {
        return PiRemoteEnvironment.current().baseUrl + path;
    }

    static final class Locked extends IOException {
        Locked(String message) { super(message); }
    }

    static final class StaleEnvironment extends IOException {
        StaleEnvironment(String id) { super("Environment changed while requesting " + id); }
    }

    private static JSONObject send(PiRemoteEnvironment.Endpoint environment, String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(environment.baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(7_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("Accept", "application/json");
        if (body != null) {
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(data); }
        }
        int status = connection.getResponseCode();
        String value;
        try {
            value = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        } finally {
            connection.disconnect();
        }
        JSONObject result = value.isEmpty() ? new JSONObject() : new JSONObject(value);
        if (status == 423) throw new Locked(result.optString("error", "Locked"));
        if (status < 200 || status >= 300)
            throw new IOException(result.optString("error", "HTTP " + status));
        return result;
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

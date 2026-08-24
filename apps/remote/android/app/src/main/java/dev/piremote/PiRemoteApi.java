package dev.piremote;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** The Android app's single HTTP boundary to the canonical Pi Remote supervisor. */
final class PiRemoteApi {
    private PiRemoteApi() {}

    static JSONObject get(String path) throws Exception {
        return request("GET", path, null);
    }

    /**
     * Every call the app makes passes through here, so answering a locked machine
     * belongs here too: unlock with the key this device holds, then repeat the
     * request. From the screen's point of view nothing happened.
     */
    static JSONObject request(String method, String path, JSONObject body) throws Exception {
        try {
            return send(method, path, body);
        } catch (Locked locked) {
            PiRemoteKey.ensureUnlocked();
            return send(method, path, body);
        }
    }

    static JSONObject unlockRequest(JSONObject body) throws Exception {
        return send("POST", "/v1/unlock", body);
    }

    /** The machine has no supervisor running for this person yet. */
    static final class Locked extends IOException {
        Locked(String message) { super(message); }
    }

    private static JSONObject send(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.SERVER_URL + path).openConnection();
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

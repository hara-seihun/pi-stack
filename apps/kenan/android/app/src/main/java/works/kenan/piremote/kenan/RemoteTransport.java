package works.kenan.piremote.kenan;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

final class RemoteTransport {
    static final class AccessDenied extends IOException {
        AccessDenied() { super("Session no longer has access. Open Kenan to unlock again."); }
    }

    static JSONObject get(String url, RemoteSession.Identity identity) throws IOException {
        if (identity == null) throw new AccessDenied();
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(7_000);
        connection.setReadTimeout(7_000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("x-pi-remote-user", identity.user);
        connection.setRequestProperty("x-pi-remote-session", identity.session);
        try {
            int status = connection.getResponseCode();
            if (status == 401 || status == 403 || status == 423) throw new AccessDenied();
            if (status != 200) throw new IOException("Router returned HTTP " + status);
            try (InputStream stream = connection.getInputStream()) {
                return new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            } catch (JSONException failure) { throw new IOException("Invalid router response", failure); }
        } finally { connection.disconnect(); }
    }
}

package works.kenan.piremote.kenan;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

final class RemoteTransport {
    private static final int CONNECT_TIMEOUT_MS = 7_000;
    private static final String HOST_KEY_ALIAS = "kenan-remote";
    private Session sshSession;
    private RemoteEnvironment.Ssh activeConfig;

    synchronized void prepare(RemoteEnvironment.Endpoint endpoint) throws IOException {
        if (endpoint.authentication == RemoteEnvironment.Authentication.SSH) ensureSsh(endpoint.ssh);
    }

    synchronized void verify(RemoteEnvironment.Endpoint endpoint, String user) throws IOException {
        prepare(endpoint);
        try {
            verifyEndpoint(endpoint, user);
        } catch (IOException failure) {
            if (endpoint.authentication == RemoteEnvironment.Authentication.SSH) disconnect();
            throw failure;
        }
    }

    private void verifyEndpoint(RemoteEnvironment.Endpoint endpoint, String user) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint.baseUrl + "/v1/health").openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(CONNECT_TIMEOUT_MS);
        connection.setUseCaches(false);
        if (user != null && !user.isBlank()) connection.setRequestProperty("x-pi-remote-user", user);
        try {
            int status = connection.getResponseCode();
            String body = "";
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (stream != null) try (stream) { body = new String(stream.readAllBytes(), StandardCharsets.UTF_8); }
            verifyHealth(endpoint.id, status, body);
        } finally {
            connection.disconnect();
        }
    }

    static void verifyHealth(String expectedEnvironment, int status, String body) throws IOException {
        if (status != 200) throw new IOException("Pi Remote health check returned HTTP " + status);
        try {
            String actual = new JSONObject(body).optString("environmentId", "");
            if (!expectedEnvironment.equals(actual))
                throw new IOException("Expected Pi Remote environment " + expectedEnvironment + " but reached " + actual);
        } catch (JSONException invalid) {
            throw new IOException("Pi Remote health check returned invalid JSON", invalid);
        }
    }

    synchronized void close() {
        disconnect();
    }

    private void ensureSsh(RemoteEnvironment.Ssh config) throws IOException {
        if (sshSession != null && sshSession.isConnected() && activeConfig == config) return;
        disconnect();

        Session candidate = null;
        try {
            String[] hostKey = config.hostKey.trim().split("\\s+");
            if (hostKey.length != 2) throw new IOException("SSH host key must contain an algorithm and key");
            byte[] privateKey;
            try {
                privateKey = Base64.getDecoder().decode(config.privateKeyBase64);
            } catch (IllegalArgumentException invalid) {
                throw new IOException("SSH private key is not valid base64", invalid);
            }

            JSch jsch = new JSch();
            String knownHost = HOST_KEY_ALIAS + " " + hostKey[0] + " " + hostKey[1] + "\n";
            jsch.setKnownHosts(new ByteArrayInputStream(knownHost.getBytes(StandardCharsets.US_ASCII)));
            jsch.addIdentity("kenan-android", privateKey, null, null);

            candidate = jsch.getSession(config.user, config.host, config.port);
            candidate.setHostKeyAlias(HOST_KEY_ALIAS);
            candidate.setConfig("StrictHostKeyChecking", "yes");
            candidate.setConfig("PreferredAuthentications", "publickey");
            candidate.setServerAliveInterval(15_000);
            candidate.setServerAliveCountMax(3);
            candidate.connect(CONNECT_TIMEOUT_MS);
            int forwarded = candidate.setPortForwardingL(
                "127.0.0.1", config.localPort, config.remoteHost, config.remotePort);
            if (forwarded != config.localPort)
                throw new IOException("SSH assigned an unexpected local forwarding port");

            sshSession = candidate;
            activeConfig = config;
        } catch (JSchException failure) {
            if (candidate != null) candidate.disconnect();
            throw new IOException("Could not establish the Pi Remote SSH connection", failure);
        } catch (IOException failure) {
            if (candidate != null) candidate.disconnect();
            throw failure;
        }
    }

    private void disconnect() {
        if (sshSession != null) sshSession.disconnect();
        sshSession = null;
        activeConfig = null;
    }
}

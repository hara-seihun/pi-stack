package dev.piremote;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.List;

final class PiRemoteEnvironment {
    enum Authentication {
        DIRECT,
        SSH;

        static Authentication parse(String value) {
            if ("direct".equalsIgnoreCase(value)) return DIRECT;
            if ("ssh".equalsIgnoreCase(value)) return SSH;
            throw new IllegalArgumentException("Unknown Pi Remote authentication scheme: " + value);
        }
    }

    static final class Ssh {
        final String host;
        final int port;
        final String user;
        final String privateKeyBase64;
        final String hostKey;
        final int localPort;
        final String remoteHost;
        final int remotePort;

        Ssh(String host, int port, String user, String privateKeyBase64, String hostKey,
            int localPort, String remoteHost, int remotePort) {
            this.host = required("SSH host", host);
            this.port = validPort("SSH port", port);
            this.user = required("SSH user", user);
            this.privateKeyBase64 = required("SSH private key", privateKeyBase64);
            this.hostKey = required("SSH host key", hostKey);
            this.localPort = validPort("SSH local port", localPort);
            this.remoteHost = required("SSH remote host", remoteHost);
            this.remotePort = validPort("SSH remote port", remotePort);
        }

        private static String required(String label, String value) {
            if (value == null || value.isBlank()) throw new IllegalArgumentException(label + " is empty");
            return value.trim();
        }

        private static int validPort(String label, int value) {
            if (value < 1 || value > 65_535) throw new IllegalArgumentException(label + " is invalid");
            return value;
        }
    }

    static final class Endpoint {
        final String id;
        final String name;
        final String baseUrl;
        final boolean requiresUnlock;
        final Authentication authentication;
        final Ssh ssh;

        private Endpoint(String id, String name, String baseUrl, boolean requiresUnlock,
            Authentication authentication, Ssh ssh) {
            this.id = id;
            this.name = name;
            this.baseUrl = normalize(baseUrl);
            this.requiresUnlock = requiresUnlock;
            this.authentication = authentication;
            this.ssh = ssh;
        }

        static Endpoint direct(String id, String name, String baseUrl, boolean requiresUnlock) {
            return new Endpoint(id, name, baseUrl, requiresUnlock, Authentication.DIRECT, null);
        }

        static Endpoint ssh(String id, String name, boolean requiresUnlock, Ssh ssh) {
            return new Endpoint(id, name, "http://127.0.0.1:" + ssh.localPort,
                requiresUnlock, Authentication.SSH, ssh);
        }

        private static String normalize(String value) {
            if (value == null || value.isBlank()) throw new IllegalArgumentException("Pi Remote endpoint is empty");
            String normalized = value.trim();
            while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
            return normalized;
        }
    }

    private static final String PREFERENCES = "pi-remote-environment";
    private static final String SELECTED = "selected";
    private static final Endpoint LOCAL = Endpoint.direct("local", "Local", BuildConfig.LOCAL_SERVER_URL, true);
    private static final Endpoint CONVERGE = converge();
    private static final List<Endpoint> ALL = List.of(LOCAL, CONVERGE);

    private static Context context;
    private static volatile Endpoint selected = LOCAL;
    private static long generation;

    private PiRemoteEnvironment() {}

    private static Endpoint converge() {
        Authentication authentication = Authentication.parse(BuildConfig.CONVERGE_AUTH);
        if (authentication == Authentication.DIRECT)
            return Endpoint.direct("converge", "Converge", BuildConfig.CONVERGE_SERVER_URL, false);
        return Endpoint.ssh("converge", "Converge", false, new Ssh(
            BuildConfig.CONVERGE_SSH_HOST,
            BuildConfig.CONVERGE_SSH_PORT,
            BuildConfig.CONVERGE_SSH_USER,
            BuildConfig.CONVERGE_SSH_PRIVATE_KEY_BASE64,
            BuildConfig.CONVERGE_SSH_HOST_KEY,
            BuildConfig.CONVERGE_SSH_LOCAL_PORT,
            BuildConfig.CONVERGE_SSH_REMOTE_HOST,
            BuildConfig.CONVERGE_SSH_REMOTE_PORT));
    }

    static synchronized void attach(Context applicationContext) {
        context = applicationContext;
        String id = preferences().getString(SELECTED, LOCAL.id);
        try {
            selected = find(id);
        } catch (IllegalArgumentException ignored) {
            selected = LOCAL;
            preferences().edit().putString(SELECTED, LOCAL.id).apply();
        }
    }

    static Endpoint current() {
        return selected;
    }

    static synchronized long generation() {
        return generation;
    }

    static synchronized boolean select(String id) {
        Endpoint next = find(id);
        if (next.id.equals(selected.id)) return false;
        selected = next;
        generation++;
        preferences().edit().putString(SELECTED, next.id).apply();
        return true;
    }

    static List<Endpoint> all() {
        return ALL;
    }

    static Endpoint find(String id) {
        for (Endpoint endpoint : ALL) if (endpoint.id.equals(id)) return endpoint;
        throw new IllegalArgumentException("Unknown Pi Remote environment: " + id);
    }

    static String scoped(String key) {
        return selected.id + ":" + key;
    }

    private static SharedPreferences preferences() {
        if (context == null) throw new IllegalStateException("PiRemoteEnvironment is not attached");
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}

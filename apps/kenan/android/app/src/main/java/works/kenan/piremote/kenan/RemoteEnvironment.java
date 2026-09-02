package works.kenan.piremote.kenan;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class RemoteEnvironment {
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

    private static final String PREFERENCES = "kenan-environment";
    private static final String SELECTED = "selected";
    private static final List<Endpoint> ALL = parse(BuildConfig.ENDPOINTS);

    private final SharedPreferences preferences;
    private volatile Endpoint selected;

    RemoteEnvironment(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        Endpoint initial;
        try {
            initial = find(preferences.getString(SELECTED, ALL.get(0).id));
        } catch (IllegalArgumentException ignored) {
            initial = ALL.get(0);
            preferences.edit().putString(SELECTED, initial.id).apply();
        }
        selected = initial;
    }

    /** The build's endpoint declaration: a JSON list, direct URLs or pinned SSH forwards. */
    static List<Endpoint> parse(String json) {
        try {
            JSONArray declared = new JSONArray(json);
            if (declared.length() == 0) throw new IllegalArgumentException("No Pi Remote endpoints declared");
            List<Endpoint> endpoints = new ArrayList<>();
            Set<String> ids = new HashSet<>();
            for (int index = 0; index < declared.length(); index++) {
                JSONObject entry = declared.getJSONObject(index);
                String id = entry.getString("id");
                if (!ids.add(id)) throw new IllegalArgumentException("Repeated Pi Remote endpoint id: " + id);
                String name = entry.optString("name", id);
                boolean requiresUnlock = entry.optBoolean("requiresUnlock", false);
                Authentication authentication = Authentication.parse(entry.optString("auth", "direct"));
                if (authentication == Authentication.DIRECT) {
                    endpoints.add(Endpoint.direct(id, name, entry.getString("url"), requiresUnlock));
                } else {
                    JSONObject ssh = entry.getJSONObject("ssh");
                    endpoints.add(Endpoint.ssh(id, name, requiresUnlock, new Ssh(
                        ssh.getString("host"),
                        ssh.optInt("port", 22),
                        ssh.getString("user"),
                        ssh.getString("privateKeyBase64"),
                        ssh.getString("hostKey"),
                        ssh.getInt("localPort"),
                        ssh.optString("remoteHost", "127.0.0.1"),
                        ssh.optInt("remotePort", 8788))));
                }
            }
            return Collections.unmodifiableList(endpoints);
        } catch (JSONException cause) {
            throw new IllegalArgumentException("Invalid Pi Remote endpoint declaration: " + cause.getMessage(), cause);
        }
    }

    Endpoint current() {
        return selected;
    }

    synchronized Endpoint select(String id) {
        Endpoint next = find(id);
        if (!next.id.equals(selected.id)) {
            selected = next;
            preferences.edit().putString(SELECTED, next.id).apply();
        }
        return selected;
    }

    List<Endpoint> all() {
        return ALL;
    }

    static Endpoint find(String id) {
        for (Endpoint endpoint : ALL) if (endpoint.id.equals(id)) return endpoint;
        throw new IllegalArgumentException("Unknown Pi Remote environment: " + id);
    }
}

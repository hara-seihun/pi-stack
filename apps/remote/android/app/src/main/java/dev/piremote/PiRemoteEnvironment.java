package dev.piremote;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.List;

final class PiRemoteEnvironment {
    static final class Endpoint {
        final String id;
        final String name;
        final String baseUrl;
        final boolean requiresUnlock;

        Endpoint(String id, String name, String baseUrl, boolean requiresUnlock) {
            this.id = id;
            this.name = name;
            this.baseUrl = normalize(baseUrl);
            this.requiresUnlock = requiresUnlock;
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
    private static final Endpoint LOCAL = new Endpoint("local", "Local", BuildConfig.LOCAL_SERVER_URL, true);
    private static final Endpoint CONVERGE = new Endpoint("converge", "Converge", BuildConfig.CONVERGE_SERVER_URL, false);
    private static final List<Endpoint> ALL = List.of(LOCAL, CONVERGE);

    private static Context context;
    private static volatile Endpoint selected = LOCAL;
    private static long generation;

    private PiRemoteEnvironment() {}

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

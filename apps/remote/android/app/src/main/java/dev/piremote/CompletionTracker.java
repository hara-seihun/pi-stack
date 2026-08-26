package dev.piremote;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class CompletionTracker {
    static final class Snapshot {
        final String environmentId;
        final String id;
        final String name;
        final String state;
        final String lastAssistantText;

        Snapshot(String id, String name, String state) {
            this("local", id, name, state, null);
        }

        Snapshot(String id, String name, String state, String lastAssistantText) {
            this("local", id, name, state, lastAssistantText);
        }

        Snapshot(String environmentId, String id, String name, String state, String lastAssistantText) {
            this.environmentId = environmentId;
            this.id = id;
            this.name = name;
            this.state = state;
            this.lastAssistantText = lastAssistantText;
        }
    }

    static final class Completion {
        final String environmentId;
        final String id;
        final String name;
        final String state;
        final String lastAssistantText;

        Completion(String environmentId, String id, String name, String state, String lastAssistantText) {
            this.environmentId = environmentId;
            this.id = id;
            this.name = name;
            this.state = state;
            this.lastAssistantText = lastAssistantText;
        }
    }

    private static final class Watch {
        final String environmentId;
        final String id;
        String name;

        Watch(String environmentId, String id, String name) {
            this.environmentId = environmentId;
            this.id = id;
            this.name = name;
        }
    }

    private final LinkedHashMap<String, Watch> watched = new LinkedHashMap<>();

    void watch(String id, String name) {
        watch("local", id, name);
    }

    void watch(String environmentId, String id, String name) {
        if (environmentId == null || environmentId.isEmpty() || id == null || id.isEmpty()) return;
        watched.put(key(environmentId, id), new Watch(environmentId, id, displayName(name)));
    }

    void remove(String id) {
        remove("local", id);
    }

    void remove(String environmentId, String id) {
        watched.remove(key(environmentId, id));
    }

    boolean isEmpty() {
        return watched.isEmpty();
    }

    int size() {
        return watched.size();
    }

    List<Snapshot> watched() {
        List<Snapshot> result = new ArrayList<>();
        for (Watch item : watched.values())
            result.add(new Snapshot(item.environmentId, item.id, item.name, "", null));
        return result;
    }

    List<Completion> update(Collection<Snapshot> sessions) {
        return updateEnvironment(null, sessions);
    }

    List<Completion> updateEnvironment(String environmentId, Collection<Snapshot> sessions) {
        Map<String, Snapshot> current = new LinkedHashMap<>();
        for (Snapshot session : sessions) current.put(key(session.environmentId, session.id), session);

        List<Completion> completed = new ArrayList<>();
        for (Map.Entry<String, Watch> entry : new ArrayList<>(watched.entrySet())) {
            Watch item = entry.getValue();
            if (environmentId != null && !environmentId.equals(item.environmentId)) continue;
            Snapshot session = current.get(entry.getKey());
            if (session == null) {
                watched.remove(entry.getKey());
                continue;
            }
            item.name = session.name == null || session.name.isEmpty() ? item.name : session.name;
            if (!isActive(session.state)) {
                watched.remove(entry.getKey());
                completed.add(new Completion(item.environmentId, item.id, item.name, session.state, session.lastAssistantText));
            }
        }
        return completed;
    }

    static boolean isActive(String state) {
        return "RUNNING".equals(state) || "STARTING".equals(state) || "ABORTING".equals(state);
    }

    private static String key(String environmentId, String id) {
        return environmentId + "\u0000" + id;
    }

    private static String displayName(String value) {
        return value == null || value.isEmpty() ? "Thread" : value;
    }
}

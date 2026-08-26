package dev.piremote;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class CompletionTracker {
    static final class Snapshot {
        final String id;
        final String name;
        final String state;
        final String lastAssistantText;

        Snapshot(String id, String name, String state) {
            this(id, name, state, null);
        }

        Snapshot(String id, String name, String state, String lastAssistantText) {
            this.id = id;
            this.name = name;
            this.state = state;
            this.lastAssistantText = lastAssistantText;
        }
    }

    static final class Completion {
        final String id;
        final String name;
        final String state;
        final String lastAssistantText;

        Completion(String id, String name, String state, String lastAssistantText) {
            this.id = id;
            this.name = name;
            this.state = state;
            this.lastAssistantText = lastAssistantText;
        }
    }

    private final LinkedHashMap<String, String> watched = new LinkedHashMap<>();

    void watch(String id, String name) {
        if (id == null || id.isEmpty()) return;
        watched.put(id, name == null || name.isEmpty() ? "Thread" : name);
    }

    void remove(String id) {
        watched.remove(id);
    }

    boolean isEmpty() {
        return watched.isEmpty();
    }

    int size() {
        return watched.size();
    }

    List<Snapshot> watched() {
        List<Snapshot> result = new ArrayList<>();
        for (Map.Entry<String, String> item : watched.entrySet())
            result.add(new Snapshot(item.getKey(), item.getValue(), ""));
        return result;
    }

    List<Completion> update(Collection<Snapshot> sessions) {
        Map<String, Snapshot> current = new LinkedHashMap<>();
        for (Snapshot session : sessions) current.put(session.id, session);

        List<Completion> completed = new ArrayList<>();
        for (Map.Entry<String, String> item : new ArrayList<>(watched.entrySet())) {
            Snapshot session = current.get(item.getKey());
            if (session == null) {
                watched.remove(item.getKey());
                continue;
            }
            String name = session.name == null || session.name.isEmpty() ? item.getValue() : session.name;
            watched.put(item.getKey(), name);
            if (!isActive(session.state)) {
                watched.remove(item.getKey());
                completed.add(new Completion(item.getKey(), name, session.state, session.lastAssistantText));
            }
        }
        return completed;
    }

    static boolean isActive(String state) {
        return "RUNNING".equals(state) || "STARTING".equals(state) || "ABORTING".equals(state);
    }
}

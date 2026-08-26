package dev.piremote;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class CompletionTracker {
    static final long IDLE_GRACE_MS = 1_000;

    static final class Snapshot {
        final String environmentId;
        final String id;
        final String name;
        final String state;
        final String activity;
        final String lastAssistantText;

        Snapshot(String id, String name, String state) {
            this("local", id, name, state, state, null);
        }

        Snapshot(String id, String name, String state, String lastAssistantText) {
            this("local", id, name, state, state, lastAssistantText);
        }

        Snapshot(String environmentId, String id, String name, String state, String lastAssistantText) {
            this(environmentId, id, name, state, state, lastAssistantText);
        }

        Snapshot(String environmentId, String id, String name, String state, String activity, String lastAssistantText) {
            this.environmentId = environmentId;
            this.id = id;
            this.name = name;
            this.state = state;
            this.activity = activity;
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
        Snapshot pendingIdle;
        long idleAt;

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
        return updateEnvironment(null, sessions, System.currentTimeMillis());
    }

    List<Completion> updateEnvironment(String environmentId, Collection<Snapshot> sessions) {
        return updateEnvironment(environmentId, sessions, System.currentTimeMillis());
    }

    List<Completion> updateEnvironment(String environmentId, Collection<Snapshot> sessions, long at) {
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
            if (isActive(session.state, session.activity)) {
                item.pendingIdle = null;
                item.idleAt = 0;
            } else if ("IDLE".equals(session.state)) {
                if (item.pendingIdle == null) item.idleAt = at;
                item.pendingIdle = session;
            } else {
                watched.remove(entry.getKey());
                completed.add(completion(item, session));
            }
        }
        return completed;
    }

    List<Completion> completeDue(long at) {
        List<Completion> completed = new ArrayList<>();
        for (Map.Entry<String, Watch> entry : new ArrayList<>(watched.entrySet())) {
            Watch item = entry.getValue();
            if (item.pendingIdle == null || at < item.idleAt + IDLE_GRACE_MS) continue;
            watched.remove(entry.getKey());
            completed.add(completion(item, item.pendingIdle));
        }
        return completed;
    }

    long nextCompletionAt() {
        long next = Long.MAX_VALUE;
        for (Watch item : watched.values())
            if (item.pendingIdle != null) next = Math.min(next, item.idleAt + IDLE_GRACE_MS);
        return next;
    }

    static boolean isActive(String state) {
        return isActive(state, state);
    }

    static boolean isActive(String state, String activity) {
        return "RUNNING".equals(state) || "STARTING".equals(state) || "ABORTING".equals(state)
            || "COMPACTING".equals(activity);
    }

    private static Completion completion(Watch item, Snapshot session) {
        return new Completion(item.environmentId, item.id, item.name, session.state, session.lastAssistantText);
    }

    private static String key(String environmentId, String id) {
        return environmentId + "\u0000" + id;
    }

    private static String displayName(String value) {
        return value == null || value.isEmpty() ? "Thread" : value;
    }
}

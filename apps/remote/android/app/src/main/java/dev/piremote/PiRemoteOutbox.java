package dev.piremote;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

final class PiRemoteOutbox {
    private static final String PREFERENCES = "prompt_outbox";
    private static final String ENTRIES = "entries";

    static final class Entry {
        final String environmentId;
        final String sessionId;
        final String requestId;
        final String text;
        final String delivery;
        Entry(String environmentId, String sessionId, String requestId, String text, String delivery) {
            this.environmentId = environmentId;
            this.sessionId = sessionId;
            this.requestId = requestId;
            this.text = text;
            this.delivery = delivery;
        }
        JSONObject json() throws Exception {
            return new JSONObject().put("environmentId", environmentId).put("sessionId", sessionId)
                .put("requestId", requestId).put("text", text).put("delivery", delivery);
        }
    }

    private PiRemoteOutbox() {}

    static synchronized Entry enqueue(Context context, String environmentId, String sessionId, String text, String delivery) throws Exception {
        Entry entry = new Entry(environmentId, sessionId, java.util.UUID.randomUUID().toString(), text, delivery);
        JSONArray values = values(context); values.put(entry.json()); commit(context, values);
        return entry;
    }

    static synchronized List<Entry> pending(Context context, String environmentId) {
        List<Entry> result = new ArrayList<>();
        JSONArray values = values(context);
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index); if (value == null) continue;
            if (!environmentId.equals(value.optString("environmentId"))) continue;
            result.add(new Entry(environmentId, value.optString("sessionId"), value.optString("requestId"),
                value.optString("text"), value.optString("delivery", "followUp")));
        }
        return result;
    }

    static synchronized void remove(Context context, String requestId) {
        JSONArray source = values(context); JSONArray target = new JSONArray();
        for (int index = 0; index < source.length(); index++) {
            JSONObject value = source.optJSONObject(index);
            if (value != null && !requestId.equals(value.optString("requestId"))) target.put(value);
        }
        commit(context, target);
    }

    private static JSONArray values(Context context) {
        try { return new JSONArray(preferences(context).getString(ENTRIES, "[]")); }
        catch (Exception damaged) { return new JSONArray(); }
    }

    private static void commit(Context context, JSONArray values) {
        if (!preferences(context).edit().putString(ENTRIES, values.toString()).commit())
            throw new IllegalStateException("Could not commit prompt outbox");
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}

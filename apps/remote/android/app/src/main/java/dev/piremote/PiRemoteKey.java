package dev.piremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;

import org.json.JSONObject;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * The key to this person's folder, held on the device and sent to the machine
 * when her supervisor is not running.
 *
 * <p>The machine keeps no copy: her folder and her whole transcript ledger are
 * encrypted there, and the supervisor that can read them exists only for as
 * long as it holds this key in memory. So a locked server is the ordinary state
 * after a reboot rather than a fault, and the app's job is to answer it without
 * involving her. She is asked once, on the first launch after this arrives, and
 * again only if the key stops working.
 */
final class PiRemoteKey {
    /** Asks the person for her key. Returns null if she dismisses the request. */
    interface Prompter {
        void ask(String failureMessage, BlockingQueue<String> answer);
    }

    private static final String PREFERENCES = "pi-remote-key";
    private static final String KEY = "key";
    private static final Object LOCK = new Object();

    private static Context context;
    private static volatile Prompter prompter;

    private PiRemoteKey() {}

    static void attach(Context applicationContext) {
        context = applicationContext;
    }

    static void setPrompter(Prompter value) {
        prompter = value;
    }

    private static SharedPreferences preferences() {
        return context == null ? null : context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String stored() {
        SharedPreferences preferences = preferences();
        return preferences == null ? null : preferences.getString(KEY, null);
    }

    private static void remember(String key) {
        SharedPreferences preferences = preferences();
        if (preferences != null) preferences.edit().putString(KEY, key).apply();
    }

    /**
     * Unlocks the machine for this person, asking her for the key only when the
     * stored one is missing or no longer works. Blocks the calling thread, which
     * is always a background thread; the main thread would deadlock against the
     * dialog it is waiting for, so it fails there instead.
     */
    static void ensureUnlocked() throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Locked");
        synchronized (LOCK) {
            String key = stored();
            String failure = null;
            for (int attempt = 0; attempt < 20; attempt++) {
                if (key != null && !key.isEmpty()) {
                    try {
                        unlock(key);
                        remember(key);
                        return;
                    } catch (Exception refused) {
                        failure = refused.getMessage() == null ? "Could not unlock" : refused.getMessage();
                    }
                }
                Prompter asking = prompter;
                if (asking == null) throw new IllegalStateException(failure == null ? "Locked" : failure);
                BlockingQueue<String> answer = new ArrayBlockingQueue<>(1);
                asking.ask(failure, answer);
                String supplied = answer.poll(10, TimeUnit.MINUTES);
                if (supplied == null || supplied.isEmpty()) throw new IllegalStateException("Locked");
                key = supplied;
            }
            throw new IllegalStateException("Locked");
        }
    }

    private static void unlock(String key) throws Exception {
        JSONObject body = new JSONObject();
        body.put("key", key);
        PiRemoteApi.unlockRequest(body);
    }
}

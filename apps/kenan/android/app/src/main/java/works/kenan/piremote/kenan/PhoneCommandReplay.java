package works.kenan.piremote.kenan;

import android.content.Context;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Consumer;
import org.json.JSONArray;

/** Process-owned ordered acceptance survives overlapping service lifetimes. */
final class PhoneCommandReplay {
    enum Acceptance { PERSISTED, DUPLICATE, STATE_ERROR, BUSY }
    private static final ExecutorService executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(512));
    static void accept(Context context, String id, Consumer<Acceptance> done) {
        try { executor.execute(() -> done.accept(persist(context, id))); }
        catch (RejectedExecutionException full) { done.accept(Acceptance.BUSY); }
    }
    private static Acceptance persist(Context context, String id) {
        try {
            var settings = PhoneControlService.settings(context);
            JSONArray saved = new JSONArray(settings.getString("seenCommands", "[]"));
            LinkedHashSet<String> ids = new LinkedHashSet<>();
            for (int i = 0; i < saved.length(); i++) ids.add(saved.getString(i));
            if (!ids.add(id)) return Acceptance.DUPLICATE;
            while (ids.size() > 512) ids.remove(ids.iterator().next());
            return settings.edit().putString("seenCommands", new JSONArray(ids).toString()).commit()
                ? Acceptance.PERSISTED : Acceptance.STATE_ERROR;
        } catch (org.json.JSONException | RuntimeException failure) {
            return Acceptance.STATE_ERROR;
        }
    }
}

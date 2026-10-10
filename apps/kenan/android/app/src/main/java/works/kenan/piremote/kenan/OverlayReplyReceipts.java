package works.kenan.piremote.kenan;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Reply presentation receipts are independent of transport-command acceptance. */
final class OverlayReplyReceipts {
    enum Reservation { PENDING, DISPLAYED, CONFLICT, STATE_ERROR }
    interface Presenter { void present(Runnable drawn, Consumer<PhoneResult> failed); }
    private static final ThreadPoolExecutor journal = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(512));
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final Set<String> active = new HashSet<>();
    private static final Set<String> uncertainDraws = new HashSet<>();

    static void afterDraw(Runnable drawn) { main.post(drawn); }
    static String key(String user, String receiptId) { return digest(user + "\0" + receiptId); }
    private static String digest(String value) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte part : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", part & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException defect) { throw new IllegalStateException(defect); }
    }
    static Reservation reserve(Context context, String user, String receiptId, String text) {
        var preferences = context.getSharedPreferences("overlay-reply-receipts", Context.MODE_PRIVATE);
        String key = key(user, receiptId);
        String hash = digest(text);
        try {
            String saved = preferences.getString(key, null);
            if (saved != null) {
                JSONObject record = new JSONObject(saved);
                if (!hash.equals(record.getString("textHash"))) return Reservation.CONFLICT;
                return switch (record.getString("state")) {
                    case "pending" -> Reservation.PENDING;
                    case "displayed" -> Reservation.DISPLAYED;
                    default -> Reservation.STATE_ERROR;
                };
            }
            return preferences.edit().putString(key, new JSONObject().put("textHash", hash).put("state", "pending").toString()).commit()
                ? Reservation.PENDING : Reservation.STATE_ERROR;
        } catch (org.json.JSONException | RuntimeException failure) { return Reservation.STATE_ERROR; }
    }
    static boolean displayed(Context context, String user, String receiptId, String text) {
        var preferences = context.getSharedPreferences("overlay-reply-receipts", Context.MODE_PRIVATE);
        String key = key(user, receiptId);
        try {
            String saved = preferences.getString(key, null);
            if (saved == null) return false;
            JSONObject record = new JSONObject(saved);
            if (!digest(text).equals(record.getString("textHash")) || !"pending".equals(record.getString("state"))) return false;
            return preferences.edit().putString(key, record.put("state", "displayed").toString()).commit();
        } catch (org.json.JSONException | RuntimeException failure) { return false; }
    }
    static PhoneResult acknowledgement(String receiptId, boolean duplicate) {
        try { return PhoneResult.success(new JSONObject().put("displayed", true).put("receiptId", receiptId).put("duplicate", duplicate)); }
        catch (org.json.JSONException defect) { throw new IllegalStateException(defect); }
    }
    static void deliver(Context context, String user, JSONObject args, long deadline, BooleanSupplier authorized,
                        Presenter presenter, Consumer<PhoneResult> done) {
        Object suppliedId = args.opt("receiptId"), suppliedText = args.opt("text");
        if (!(suppliedId instanceof String receiptId) || receiptId.isBlank() || receiptId.length() > 512
            || !(suppliedText instanceof String text) || text.isBlank() || text.length() > 2000 || user.isBlank()) {
            done.accept(PhoneResult.error("invalid_args", "Reply presentation requires a receiptId (1..512) and nonblank text (1..2000)")); return;
        }
        String key = key(user, receiptId);
        synchronized (active) {
            if (uncertainDraws.contains(key)) { done.accept(PhoneResult.error("unconfirmed", "Reply drew but durable acknowledgement is unresolved")); return; }
            if (!active.add(key)) { done.accept(PhoneResult.error("busy", "Reply presentation is in flight; retry this receipt after its result")); return; }
        }
        var finished = new java.util.concurrent.atomic.AtomicBoolean();
        Consumer<PhoneResult> finish = result -> {
            if (!finished.compareAndSet(false, true)) return;
            synchronized (active) {
                active.remove(key);
                if (!result.ok && "unconfirmed".equals(result.code)) uncertainDraws.add(key);
            }
            done.accept(result);
        };
        var presentationEnded = new java.util.concurrent.atomic.AtomicBoolean();
        try { journal.execute(() -> {
            Reservation reservation = reserve(context, user, receiptId, text);
            switch (reservation) {
                case DISPLAYED -> finish.accept(acknowledgement(receiptId, true));
                case CONFLICT -> finish.accept(PhoneResult.error("receipt_conflict", "Reply receipt text differs from its immutable payload"));
                case STATE_ERROR -> finish.accept(PhoneResult.error("state_error", "Could not read or persist reply presentation receipt"));
                case PENDING -> main.post(() -> {
                    if (!authorized.getAsBoolean() || System.currentTimeMillis() >= deadline) {
                        finish.accept(PhoneResult.error("expired", "Reply was not displayed before authorization or deadline expired")); return;
                    }
                    presenter.present(() -> {
                        if (!presentationEnded.compareAndSet(false, true)) return;
                        try { journal.execute(() -> {
                            if (displayed(context, user, receiptId, text)) finish.accept(acknowledgement(receiptId, false));
                            else finish.accept(PhoneResult.error("unconfirmed", "Reply drew but its durable acknowledgement failed"));
                        }); } catch (RejectedExecutionException full) {
                            finish.accept(PhoneResult.error("unconfirmed", "Reply drew but acknowledgement queue is full"));
                        }
                    }, failure -> { if (presentationEnded.compareAndSet(false, true)) finish.accept(failure); });
                });
            }
        }); } catch (RejectedExecutionException full) { finish.accept(PhoneResult.error("rate_limited", "Reply journal queue is full")); }
    }
    private OverlayReplyReceipts() {}
}

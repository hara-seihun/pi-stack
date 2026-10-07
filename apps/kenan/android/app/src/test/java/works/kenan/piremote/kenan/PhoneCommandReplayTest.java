package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = android.app.Application.class)
public class PhoneCommandReplayTest {
    private PhoneCommandReplay.Acceptance accept(Context context, String id) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        PhoneCommandReplay.Acceptance[] result = new PhoneCommandReplay.Acceptance[1];
        PhoneCommandReplay.accept(context, id, acceptance -> {
            assertNotSame(android.os.Looper.getMainLooper().getThread(), Thread.currentThread());
            result[0] = acceptance; done.countDown();
        });
        assertTrue(done.await(2, TimeUnit.SECONDS));
        return result[0];
    }
    @Test public void racingOwnersCannotReplayAlreadyPersistedAcceptance() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        CountDownLatch done = new CountDownLatch(2);
        List<PhoneCommandReplay.Acceptance> results = new ArrayList<>();
        for (int i = 0; i < 2; i++) PhoneCommandReplay.accept(context, "same", result -> { results.add(result); done.countDown(); });
        assertTrue(done.await(2, TimeUnit.SECONDS));
        assertEquals(List.of(PhoneCommandReplay.Acceptance.PERSISTED, PhoneCommandReplay.Acceptance.DUPLICATE), results);
    }
    @Test public void floodedAcceptanceQueueRefusesWithoutPersistingOrMutating() throws Exception {
        java.util.concurrent.ThreadPoolExecutor executor = org.robolectric.util.ReflectionHelpers.getStaticField(
            PhoneCommandReplay.class, "executor");
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        executor.execute(() -> {
            entered.countDown();
            try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        assertTrue(entered.await(1, TimeUnit.SECONDS));
        try {
            for (int i = 0; i < 512; i++) executor.execute(() -> {});
            List<PhoneCommandReplay.Acceptance> results = new ArrayList<>();
            PhoneCommandReplay.accept(RuntimeEnvironment.getApplication(), "overload", results::add);
            assertEquals(List.of(PhoneCommandReplay.Acceptance.BUSY), results);
            assertEquals("[]", PhoneControlService.settings(RuntimeEnvironment.getApplication()).getString("seenCommands", "[]"));
        } finally {
            release.countDown();
            executor.getQueue().clear();
            executor.submit(() -> {}).get(2, TimeUnit.SECONDS);
        }
    }
    @Test public void corruptLedgerReturnsStateErrorInsteadOfInventingEmptyHistory() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        PhoneControlService.settings(context).edit().putString("seenCommands", "corrupt").commit();
        assertEquals(PhoneCommandReplay.Acceptance.STATE_ERROR, accept(context, "new"));
        assertEquals("corrupt", PhoneControlService.settings(context).getString("seenCommands", ""));
    }
    @Test public void failedDiskCommitCannotAcknowledgeAcceptance() throws Exception {
        SharedPreferences.Editor editor = (SharedPreferences.Editor) Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[] { SharedPreferences.Editor.class }, (proxy, method, args) -> switch (method.getName()) {
                case "putString" -> proxy;
                case "commit" -> false;
                default -> throw new AssertionError(method.getName());
            });
        SharedPreferences preferences = (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[] { SharedPreferences.class }, (proxy, method, args) -> switch (method.getName()) {
                case "getString" -> "[]";
                case "edit" -> editor;
                default -> throw new AssertionError(method.getName());
            });
        Context context = new ContextWrapper(RuntimeEnvironment.getApplication()) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return preferences; }
        };
        assertEquals(PhoneCommandReplay.Acceptance.STATE_ERROR, accept(context, "new"));
    }
    @After public void clear() { PhoneControlService.settings(RuntimeEnvironment.getApplication()).edit().clear().commit(); }
}

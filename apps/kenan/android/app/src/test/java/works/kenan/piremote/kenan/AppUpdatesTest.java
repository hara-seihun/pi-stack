package works.kenan.piremote.kenan;

import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

public class AppUpdatesTest {
    private JSONObject release(int version) throws Exception {
        String revision = "a".repeat(40);
        return new JSONObject()
            .put("revision", revision)
            .put("versionCode", version)
            .put("applicationId", BuildConfig.APPLICATION_ID)
            .put("sha256", "b".repeat(64))
            .put("size", 1024)
            .put("fileName", revision + ".apk");
    }

    private AppUpdates.Release parse(JSONObject release) throws Exception {
        return AppUpdates.parseManifest(new JSONObject().put("release", release).toString());
    }

    @Test public void onlyNewerVersionsAreOffered() throws Exception {
        assertNull(AppUpdates.parseManifest("{\"release\":null}"));
        assertNull(parse(release(BuildConfig.VERSION_CODE)));
        assertNull(parse(release(BuildConfig.VERSION_CODE - 1)));
        assertEquals(BuildConfig.VERSION_CODE + 1, parse(release(BuildConfig.VERSION_CODE + 1)).versionCode);
    }

    @Test public void malformedManifestsAreErrorsNotNoUpdate() throws Exception {
        for (String value : new String[] { "{}", "{\"release\":false}", "not json", "{\"release\":{}}" }) {
            assertThrows(IOException.class, () -> AppUpdates.parseManifest(value));
        }
    }

    @Test public void boundsAndIdentityAreCheckedBeforeOfferingAnUpdate() throws Exception {
        Object[][] invalid = {
            {"revision", "../download"},
            {"sha256", "wrong"},
            {"applicationId", "another.app"},
            {"fileName", "other.apk"},
            {"size", AppUpdates.MAX_APK_BYTES + 1},
            {"size", 0},
            {"versionCode", 1.5},
            {"versionCode", "2000"},
            {"versionCode", 2_100_000_001L},
        };
        for (Object[] change : invalid) {
            JSONObject manifest = release(BuildConfig.VERSION_CODE + 1).put((String) change[0], change[1]);
            assertThrows(change[0].toString(), IOException.class, () -> parse(manifest));
        }
    }
}

package works.kenan.piremote.kenan;

import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

public class AppUpdatesTest {
    private static final String OTHER_SHELL = "0123456789abcdef";

    private JSONObject release(int version, String shellId) throws Exception {
        String revision = "a".repeat(40);
        JSONObject json = new JSONObject()
            .put("revision", revision)
            .put("versionCode", version)
            .put("applicationId", BuildConfig.APPLICATION_ID)
            .put("sha256", "b".repeat(64))
            .put("size", 1024)
            .put("fileName", revision + ".apk");
        if (shellId != null) json.put("shellId", shellId);
        return json;
    }

    private JSONObject web(int version, String shellId) throws Exception {
        String revision = "a".repeat(40);
        return new JSONObject()
            .put("revision", revision)
            .put("versionCode", version)
            .put("applicationId", BuildConfig.APPLICATION_ID)
            .put("shellId", shellId)
            .put("sha256", "c".repeat(64))
            .put("size", 2048)
            .put("fileName", revision + ".web.zip");
    }

    private AppUpdates.Manifest parse(JSONObject release, JSONObject web) throws Exception {
        return AppUpdates.parseManifest(new JSONObject().put("release", release == null ? JSONObject.NULL : release)
            .put("web", web == null ? JSONObject.NULL : web).toString());
    }

    private AppUpdates.Update decide(JSONObject release, JSONObject web, int runningWeb) throws Exception {
        return AppUpdates.decide(parse(release, web), BuildConfig.VERSION_CODE, BuildConfig.SHELL_ID, runningWeb, revision -> false);
    }

    @Test public void manifestsWithoutAWebBundleStillParse() throws Exception {
        AppUpdates.Manifest manifest = AppUpdates.parseManifest("{\"release\":null}");
        assertNull(manifest.release);
        assertNull(manifest.web);
        manifest = parse(release(BuildConfig.VERSION_CODE + 1, null), null);
        assertEquals(BuildConfig.VERSION_CODE + 1, manifest.release.versionCode);
        assertEquals("", manifest.release.shellId);
    }

    @Test public void webBundlesForThisShellAreAppliedInsteadOfApks() throws Exception {
        int next = BuildConfig.VERSION_CODE + 1;
        AppUpdates.Update update = decide(release(next, BuildConfig.SHELL_ID), web(next, BuildConfig.SHELL_ID), BuildConfig.VERSION_CODE);
        assertEquals("web", update.kind);
        assertEquals(next, update.versionCode);
        // Already running that web client: nothing to offer even though the APK is newer.
        assertNull(decide(release(next, BuildConfig.SHELL_ID), web(next, BuildConfig.SHELL_ID), next));
        // A web bundle alone, without an APK publication, still updates the client.
        assertEquals("web", decide(null, web(next, BuildConfig.SHELL_ID), BuildConfig.VERSION_CODE).kind);
    }

    @Test public void nativeChangesRequireTheApk() throws Exception {
        int next = BuildConfig.VERSION_CODE + 1;
        assertEquals("apk", decide(release(next, OTHER_SHELL), web(next, OTHER_SHELL), BuildConfig.VERSION_CODE).kind);
        // Older publications without shell identity are treated as native changes.
        assertEquals("apk", decide(release(next, null), null, BuildConfig.VERSION_CODE).kind);
        // A newer APK whose web bundle failed to publish is still offered.
        assertEquals("apk", decide(release(next, BuildConfig.SHELL_ID), null, BuildConfig.VERSION_CODE).kind);
        assertNull(decide(release(BuildConfig.VERSION_CODE, OTHER_SHELL), web(BuildConfig.VERSION_CODE, OTHER_SHELL), BuildConfig.VERSION_CODE));
        assertNull(decide(release(BuildConfig.VERSION_CODE - 1, null), null, BuildConfig.VERSION_CODE));
    }

    @Test public void rejectedWebBundlesAreNotOfferedAgain() throws Exception {
        int next = BuildConfig.VERSION_CODE + 1;
        AppUpdates.Manifest manifest = parse(release(next, BuildConfig.SHELL_ID), web(next, BuildConfig.SHELL_ID));
        assertNull(AppUpdates.decide(manifest, BuildConfig.VERSION_CODE, BuildConfig.SHELL_ID, BuildConfig.VERSION_CODE, revision -> true));
    }

    @Test public void malformedManifestsAreErrorsNotNoUpdate() throws Exception {
        for (String value : new String[] { "{}", "{\"release\":false}", "not json", "{\"release\":{}}", "{\"release\":null,\"web\":false}", "{\"release\":null,\"web\":{}}" }) {
            assertThrows(value, IOException.class, () -> AppUpdates.parseManifest(value));
        }
    }

    @Test public void boundsAndIdentityAreCheckedBeforeOfferingAnUpdate() throws Exception {
        Object[][] invalid = {
            {"revision", "../download"},
            {"sha256", "wrong"},
            {"applicationId", "another.app"},
            {"fileName", "other.apk"},
            {"shellId", "not-hex"},
            {"size", AppUpdates.MAX_APK_BYTES + 1},
            {"size", 0},
            {"versionCode", 1.5},
            {"versionCode", "2000"},
            {"versionCode", 2_100_000_001L},
        };
        for (Object[] change : invalid) {
            JSONObject manifest = release(BuildConfig.VERSION_CODE + 1, BuildConfig.SHELL_ID).put((String) change[0], change[1]);
            assertThrows(change[0].toString(), IOException.class, () -> parse(manifest, null));
        }
        Object[][] invalidWeb = {
            {"revision", "../download"},
            {"sha256", "wrong"},
            {"applicationId", "another.app"},
            {"fileName", "a".repeat(40) + ".apk"},
            {"shellId", "short"},
            {"size", WebBundles.MAX_ZIP_BYTES + 1},
            {"size", 0},
            {"versionCode", "2000"},
        };
        for (Object[] change : invalidWeb) {
            JSONObject manifest = web(BuildConfig.VERSION_CODE + 1, BuildConfig.SHELL_ID).put((String) change[0], change[1]);
            assertThrows(change[0].toString(), IOException.class, () -> parse(null, manifest));
        }
    }
}

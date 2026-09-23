package works.kenan.piremote.kenan;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.*;

public class WebBundlesTest {
    private static final String SHELL = "0123456789abcdef";
    private static final int BUILT_IN = 2000;
    private File root;
    private WebBundles bundles;

    @Before public void createRoot() throws IOException {
        root = Files.createTempDirectory("web-bundles").toFile();
        bundles = new WebBundles(root, BUILT_IN, SHELL);
    }

    @After public void removeRoot() {
        WebBundles.delete(root);
    }

    private static byte[] zip(String... entries) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream output = new ZipOutputStream(bytes)) {
            for (String entry : entries) {
                output.putNextEntry(new ZipEntry(entry));
                if (!entry.endsWith("/")) output.write(("content of " + entry).getBytes(StandardCharsets.UTF_8));
                output.closeEntry();
            }
        }
        return bytes.toByteArray();
    }

    private static String revision(char fill) {
        return String.valueOf(fill).repeat(40);
    }

    private AppUpdates.WebRelease release(String revision, int versionCode, String shellId, byte[] zip) throws Exception {
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest(zip)) hash.append(String.format("%02x", value & 0xff));
        return new AppUpdates.WebRelease(new JSONObject()
            .put("revision", revision).put("versionCode", versionCode).put("applicationId", BuildConfig.APPLICATION_ID)
            .put("shellId", shellId).put("sha256", hash.toString()).put("size", zip.length).put("fileName", revision + ".web.zip"));
    }

    private WebBundles.Installed stage(String revision, int versionCode, byte[] zip) throws Exception {
        AppUpdates.WebRelease release = release(revision, versionCode, SHELL, zip);
        return bundles.stage(release, (path, output, limit, timeout) -> {
            assertEquals("/v1/app-update/" + release.fileName, path);
            output.write(zip);
            return zip.length;
        });
    }

    @Test public void stagedBundlesAreUnpackedVerifiedAndActivated() throws Exception {
        String revision = revision('a');
        WebBundles.Installed installed = stage(revision, BUILT_IN + 1, zip("index.html", "assets/", "assets/app.js"));
        assertEquals(new File(root, revision), installed.directory);
        assertTrue(new File(installed.directory, "assets/app.js").isFile());
        assertTrue(new File(installed.directory, WebBundles.RELEASE_FILE).isFile());
        assertNull(bundles.active());
        assertEquals(BUILT_IN, bundles.runningVersionCode());
        assertEquals(revision, bundles.activate().revision);
        assertEquals(revision, bundles.activeRevision());
        assertEquals(BUILT_IN + 1, bundles.runningVersionCode());
        // Staging the same release again returns the existing bundle without downloading.
        AppUpdates.WebRelease release = release(revision, BUILT_IN + 1, SHELL, zip("index.html"));
        assertEquals(revision, bundles.stage(release, (path, output, limit, timeout) -> { throw new AssertionError("downloaded again"); }).revision);
    }

    @Test public void corruptDownloadsAreRejectedAndLeaveNothingBehind() throws Exception {
        byte[] good = zip("index.html");
        AppUpdates.WebRelease release = release(revision('a'), BUILT_IN + 1, SHELL, good);
        byte[] tampered = good.clone();
        tampered[tampered.length - 1] ^= 1;
        assertThrows(IOException.class, () -> bundles.stage(release, (path, output, limit, timeout) -> { output.write(tampered); return tampered.length; }));
        assertThrows(IOException.class, () -> bundles.stage(release, (path, output, limit, timeout) -> { output.write(good, 0, good.length - 1); return good.length - 1; }));
        byte[] withoutIndex = zip("other.html");
        AppUpdates.WebRelease noIndex = release(revision('b'), BUILT_IN + 1, SHELL, withoutIndex);
        assertThrows(IOException.class, () -> bundles.stage(noIndex, (path, output, limit, timeout) -> { output.write(withoutIndex); return withoutIndex.length; }));
        AppUpdates.WebRelease otherShell = release(revision('c'), BUILT_IN + 1, "fedcba9876543210", good);
        assertThrows(IOException.class, () -> bundles.stage(otherShell, (path, output, limit, timeout) -> { throw new AssertionError("downloaded"); }));
        assertNull(bundles.activate());
        String[] leftovers = root.list();
        assertNotNull(leftovers);
        for (String name : leftovers) assertEquals("state.json", name);
    }

    @Test public void zipEntriesCannotEscapeOrOverwriteTheMarker() throws Exception {
        for (String entry : new String[] { "../escape.html", "/absolute.html", "nested/../../escape.html", "release.json", "back\\slash.html" }) {
            File zip = new File(root, "candidate.zip");
            try (FileOutputStream output = new FileOutputStream(zip)) { output.write(zip("index.html", entry)); }
            File target = new File(root, "target");
            assertThrows(entry, IOException.class, () -> WebBundles.extract(zip, target));
            WebBundles.delete(target);
            assertFalse(new File(root.getParentFile(), "escape.html").exists());
        }
    }

    @Test public void unconfirmedBundlesFallBackAfterRepeatedLaunches() throws Exception {
        String older = revision('1');
        String newer = revision('2');
        stage(older, BUILT_IN + 1, zip("index.html"));
        assertEquals(older, bundles.activate().revision);
        bundles.confirmActive();
        stage(newer, BUILT_IN + 2, zip("index.html"));
        for (int launch = 0; launch < WebBundles.MAX_UNCONFIRMED_LAUNCHES; launch++) assertEquals(newer, bundles.activate().revision);
        // The newer bundle never reported ready: it is dropped and the confirmed one serves again.
        assertEquals(older, bundles.activate().revision);
        assertFalse(new File(root, newer).exists());
        assertTrue(bundles.isBad(newer));
        assertFalse(bundles.isBad(older));
        assertNull(bundles.installed(newer));
    }

    @Test public void bundlesForAnotherShellOrOlderThanTheApkAreRemoved() throws Exception {
        stage(revision('a'), BUILT_IN + 1, zip("index.html"));
        WebBundles other = new WebBundles(root, BUILT_IN, "fedcba9876543210");
        assertNull(other.activate());
        assertFalse(new File(root, revision('a')).exists());
        stage(revision('b'), BUILT_IN + 1, zip("index.html"));
        WebBundles upgraded = new WebBundles(root, BUILT_IN + 1, SHELL);
        assertNull(upgraded.activate());
        assertFalse(new File(root, revision('b')).exists());
        assertEquals(BUILT_IN + 1, upgraded.runningVersionCode());
    }

    @Test public void onlyTheNewestAndOneFallbackAreKept() throws Exception {
        stage(revision('1'), BUILT_IN + 1, zip("index.html"));
        stage(revision('2'), BUILT_IN + 2, zip("index.html"));
        stage(revision('3'), BUILT_IN + 3, zip("index.html"));
        assertEquals(revision('3'), bundles.activate().revision);
        assertFalse(new File(root, revision('1')).exists());
        assertTrue(new File(root, revision('2')).exists());
        assertTrue(new File(root, revision('3')).exists());
    }
}

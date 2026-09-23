package works.kenan.piremote.kenan;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Set;

final class AppUpdates {
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    private final Context context;
    private final File directory;

    AppUpdates(Context context) {
        this.context = context;
        directory = new File(context.getFilesDir(), "app-updates");
    }

    static final class Release {
        final String revision;
        final int versionCode;
        final String sha256;
        final long size;
        final String shellId;

        Release(JSONObject json) throws IOException {
            try {
                revision = json.getString("revision");
                sha256 = json.getString("sha256");
                versionCode = (int) integer(json, "versionCode", 2_100_000_000L);
                size = integer(json, "size", MAX_APK_BYTES);
                shellId = json.has("shellId") && !json.isNull("shellId") ? json.getString("shellId") : "";
                if (!revision.matches("[a-f0-9]{40}") || !sha256.matches("[a-fA-F0-9]{64}")
                    || !BuildConfig.APPLICATION_ID.equals(json.getString("applicationId"))
                    || !(revision + ".apk").equals(json.getString("fileName"))
                    || !(shellId.isEmpty() || shellId.matches("[a-f0-9]{16}"))) {
                    throw new IOException("The server published an invalid Android update. Ask for the release to be republished.");
                }
            } catch (JSONException failure) {
                throw new IOException("The server returned an invalid Android update manifest. Ask for the release to be republished.", failure);
            }
        }

        static long integer(JSONObject json, String name, long maximum) throws JSONException, IOException {
            Object value = json.get(name);
            if (!(value instanceof Number) || ((Number) value).doubleValue() != ((Number) value).longValue()
                || ((Number) value).longValue() < 1 || ((Number) value).longValue() > maximum) {
                throw new IOException("The Android update has an invalid " + name + ". Ask for the release to be republished.");
            }
            return ((Number) value).longValue();
        }
    }

    /** A published web client bundle: the shared client alone, delivered without a new APK. */
    static final class WebRelease {
        final String revision;
        final int versionCode;
        final String shellId;
        final String sha256;
        final long size;
        final String fileName;

        WebRelease(JSONObject json) throws IOException {
            try {
                revision = json.getString("revision");
                shellId = json.getString("shellId");
                sha256 = json.getString("sha256");
                fileName = json.getString("fileName");
                versionCode = (int) Release.integer(json, "versionCode", 2_100_000_000L);
                size = Release.integer(json, "size", WebBundles.MAX_ZIP_BYTES);
                if (!revision.matches("[a-f0-9]{40}") || !shellId.matches("[a-f0-9]{16}") || !sha256.matches("[a-fA-F0-9]{64}")
                    || !BuildConfig.APPLICATION_ID.equals(json.getString("applicationId"))
                    || !(revision + ".web.zip").equals(fileName)) {
                    throw new IOException("The server published an invalid web update. Ask for the release to be republished.");
                }
            } catch (JSONException failure) {
                throw new IOException("The server returned an invalid web update manifest. Ask for the release to be republished.", failure);
            }
        }
    }

    static final class Manifest {
        final Release release;
        final WebRelease web;

        Manifest(Release release, WebRelease web) {
            this.release = release;
            this.web = web;
        }
    }

    /** What the drawer offers: a web bundle applied in place, or an APK through Android's installer. */
    static final class Update {
        final String kind;
        final String revision;
        final int versionCode;

        Update(String kind, String revision, int versionCode) {
            this.kind = kind;
            this.revision = revision;
            this.versionCode = versionCode;
        }
    }

    Manifest fetchManifest() throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        transfer("/v1/app-update", output, 64 * 1024, 15_000);
        return parseManifest(output.toString(StandardCharsets.UTF_8.name()));
    }

    static Manifest parseManifest(String body) throws IOException {
        try {
            JSONObject response = new JSONObject(body);
            Object value = response.get("release");
            if (value != JSONObject.NULL && !(value instanceof JSONObject)) throw new JSONException("release must be an object or null");
            Object web = response.opt("web");
            if (web != null && web != JSONObject.NULL && !(web instanceof JSONObject)) throw new JSONException("web must be an object or null");
            return new Manifest(
                value == JSONObject.NULL ? null : new Release((JSONObject) value),
                web == null || web == JSONObject.NULL ? null : new WebRelease((JSONObject) web));
        } catch (JSONException failure) {
            throw new IOException("The server returned an invalid Android update manifest. Retry the check or ask for the release to be republished.", failure);
        }
    }

    interface BadBundles { boolean isBad(String revision); }

    /**
     * A web bundle for this shell that is newer than the running client wins. Otherwise a newer
     * APK is offered unless it only carries a web client this shell already runs or rejected.
     */
    static Update decide(Manifest manifest, int installedVersionCode, String shellId, int runningWebVersionCode, BadBundles bad) {
        WebRelease web = manifest.web;
        if (web != null && shellId.equals(web.shellId) && web.versionCode > runningWebVersionCode && !bad.isBad(web.revision)) {
            return new Update("web", web.revision, web.versionCode);
        }
        Release apk = manifest.release;
        if (apk != null && apk.versionCode > installedVersionCode) {
            boolean sameShell = shellId.equals(apk.shellId) && web != null && web.revision.equals(apk.revision);
            if (!sameShell) return new Update("apk", apk.revision, apk.versionCode);
        }
        return null;
    }

    Update check(WebBundles bundles) throws IOException {
        return decide(fetchManifest(), BuildConfig.VERSION_CODE, BuildConfig.SHELL_ID, bundles.runningVersionCode(), bundles::isBad);
    }

    Release check() throws IOException {
        Manifest manifest = fetchManifest();
        return manifest.release != null && manifest.release.versionCode > BuildConfig.VERSION_CODE ? manifest.release : null;
    }

    WebBundles.Installed stageWeb(WebBundles bundles) throws IOException {
        Manifest manifest = fetchManifest();
        Update update = decide(manifest, BuildConfig.VERSION_CODE, BuildConfig.SHELL_ID, bundles.runningVersionCode(), bundles::isBad);
        if (update == null || !update.kind.equals("web")) throw new IOException("No newer web client is published for this app now. Check for updates again.");
        return bundles.stage(manifest.web, AppUpdates::transfer);
    }

    File downloadCurrent() throws IOException {
        Release release = check();
        if (release == null) throw new IOException("No newer Android app is published now. Check for updates again.");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot save the update. Free some phone storage and retry.");
        File apk = downloadedFile(release.revision);
        if (apk.isFile()) {
            validate(apk, release);
            return apk;
        }
        File partial = new File(directory, release.revision + ".partial.apk");
        try {
            try (FileOutputStream output = new FileOutputStream(partial)) {
                long received = transfer("/v1/app-update/" + release.revision + ".apk", output, release.size, 180_000);
                if (received != release.size) throw new IOException("The update download was incomplete. Retry Update app.");
                output.getFD().sync();
            }
            validate(partial, release);
            if (!partial.renameTo(apk)) throw new IOException("Cannot save the checked APK. Free some phone storage and retry.");
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) {
                if (!file.equals(apk) && !file.delete()) throw new IOException("The new APK is saved, but previous update files could not be removed. Retry Update app.");
            }
            return apk;
        } finally {
            if (partial.exists() && !partial.delete()) throw new IOException("Cannot remove the incomplete download. Free some phone storage and retry Update app.");
        }
    }

    File downloadedFile(String revision) throws IOException {
        if (revision == null || !revision.matches("[a-f0-9]{40}")) throw new IOException("The saved update is unavailable. Tap Update app to download it again.");
        return new File(directory, revision + ".apk");
    }

    private void validate(File file, Release release) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException defect) { throw new IllegalStateException(defect); }
        if (file.length() != release.size) {
            discard(file);
            throw new IOException("The saved update has the wrong size. Retry Update app to download it again.");
        }
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        if (!hash.toString().equalsIgnoreCase(release.sha256)) {
            discard(file);
            throw new IOException("The update failed its SHA-256 check. Retry Update app; if it fails again, ask for the release to be republished.");
        }
        PackageManager packages = context.getPackageManager();
        PackageInfo candidate = packages.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        long version = candidate == null ? -1 : Build.VERSION.SDK_INT >= 28 ? candidate.getLongVersionCode() : candidate.versionCode;
        if (candidate == null || !BuildConfig.APPLICATION_ID.equals(candidate.packageName) || version != release.versionCode) {
            discard(file);
            throw new IOException("The APK does not match the published app identity. Ask for the release to be republished.");
        }
        try {
            PackageInfo installed = packages.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
            if (signatures(candidate).isEmpty() || !signatures(candidate).equals(signatures(installed))) {
                discard(file);
                throw new IOException("The update signing key does not match installed Kenan. Ask for an APK signed with the existing key; do not uninstall the app.");
            }
        } catch (PackageManager.NameNotFoundException defect) { throw new IllegalStateException(defect); }
    }

    private static Set<String> signatures(PackageInfo info) {
        Set<String> result = new HashSet<>();
        if (info.signatures != null) for (Signature signature : info.signatures) result.add(signature.toCharsString());
        return result;
    }

    private static void discard(File file) throws IOException {
        if (!file.delete()) throw new IOException("Cannot remove an invalid update. Free some phone storage and retry.");
    }

    static long transfer(String path, OutputStream output, long limit, int timeout) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.ROUTER_URL + path).openConnection();
        long deadline = SystemClock.elapsedRealtime() + timeout;
        connection.setConnectTimeout(7_000);
        connection.setReadTimeout(7_000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Cache-Control", "no-cache");
        try {
            int status = connection.getResponseCode();
            if (status != 200) throw new IOException("Android update request returned HTTP " + status + ". Retry; if it persists, ask for the update service to be repaired.");
            long declared = connection.getContentLengthLong();
            if (declared > limit) throw new IOException("The server sent an oversized Android update. Ask for the release to be republished.");
            long received = 0;
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[64 * 1024];
                while (true) {
                    long remaining = deadline - SystemClock.elapsedRealtime();
                    if (remaining <= 0 || Thread.currentThread().isInterrupted()) throw new IOException("The update request timed out. Check the router connection and retry.");
                    connection.setReadTimeout((int) Math.min(7_000, remaining));
                    int count = input.read(buffer);
                    if (count < 0) return received;
                    received += count;
                    if (received > limit) throw new IOException("The server sent an oversized Android update. Ask for the release to be republished.");
                    output.write(buffer, 0, count);
                }
            }
        } catch (IOException failure) {
            throw new IOException("Could not fetch the Android update from the bootstrap router: " + failure.getMessage(), failure);
        } finally { connection.disconnect(); }
    }
}

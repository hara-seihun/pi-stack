package works.kenan.piremote.kenan;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Downloaded web client bundles. The APK carries a built-in copy of the shared
 * web client; a bundle published from a commit with the same shell identity
 * replaces it without reinstalling the app. Each bundle lives in
 * {@code <root>/<revision>/} with {@code release.json} written last as its
 * completion marker. {@code state.json} records launches, confirmations and
 * bundles that failed to boot, so a broken bundle falls back after a few tries.
 */
final class WebBundles {
    static final long MAX_ZIP_BYTES = 50L * 1024 * 1024;
    static final long MAX_EXTRACTED_BYTES = 200L * 1024 * 1024;
    static final int MAX_ENTRIES = 5000;
    static final int MAX_UNCONFIRMED_LAUNCHES = 3;
    static final String RELEASE_FILE = "release.json";

    interface Download {
        long transfer(String path, OutputStream output, long limit, int timeout) throws IOException;
    }

    static final class Installed {
        final String revision;
        final int versionCode;
        final String shellId;
        final File directory;

        Installed(String revision, int versionCode, String shellId, File directory) {
            this.revision = revision;
            this.versionCode = versionCode;
            this.shellId = shellId;
            this.directory = directory;
        }
    }

    private final File root;
    private final int builtInVersionCode;
    private final String shellId;

    WebBundles(Context context) {
        this(new File(context.getFilesDir(), "web-bundles"), BuildConfig.VERSION_CODE, BuildConfig.SHELL_ID);
    }

    WebBundles(File root, int builtInVersionCode, String shellId) {
        this.root = root;
        this.builtInVersionCode = builtInVersionCode;
        this.shellId = shellId;
    }

    /** Selects the bundle to serve for this launch, or null for the built-in client. Prunes unusable bundles. */
    synchronized Installed activate() {
        JSONObject state = state();
        JSONObject bundles = state.optJSONObject("bundles");
        if (bundles == null) bundles = new JSONObject();
        Installed chosen = null;
        List<Installed> usable = new ArrayList<>();
        File[] entries = root.listFiles();
        if (entries != null) for (File entry : entries) {
            if (entry.getName().equals("state.json")) continue;
            if (!entry.getName().matches("[a-f0-9]{40}")) {
                // Leftovers from an interrupted stage; a download may still be running, so only clear stale ones.
                if (System.currentTimeMillis() - entry.lastModified() > 10 * 60_000L) delete(entry);
                continue;
            }
            Installed candidate = read(entry);
            JSONObject record = bundles.optJSONObject(entry.getName());
            boolean bad = record != null && record.optBoolean("bad", false);
            if (candidate != null && record != null && !record.optBoolean("confirmed", false)
                && record.optInt("launches", 0) >= MAX_UNCONFIRMED_LAUNCHES) {
                bad = true;
                try { record.put("bad", true); } catch (JSONException ignored) { }
            }
            if (candidate == null || bad || !fits(candidate)) {
                delete(entry);
                continue;
            }
            usable.add(candidate);
            if (chosen == null || candidate.versionCode > chosen.versionCode) chosen = candidate;
        }
        for (Installed bundle : usable) {
            boolean keep = bundle == chosen || (usable.size() > 1 && bundle == fallback(usable, chosen));
            if (!keep) delete(bundle.directory);
        }
        try {
            if (chosen != null) {
                JSONObject record = bundles.optJSONObject(chosen.revision);
                if (record == null) bundles.put(chosen.revision, record = new JSONObject());
                if (!record.optBoolean("confirmed", false)) record.put("launches", record.optInt("launches", 0) + 1);
            }
            for (Iterator<String> names = bundles.keys(); names.hasNext();) {
                String name = names.next();
                JSONObject record = bundles.optJSONObject(name);
                if (!new File(root, name).isDirectory() && (record == null || !record.optBoolean("bad", false))) names.remove();
            }
            state.put("bundles", bundles);
            state.put("active", chosen == null ? "" : chosen.revision);
        } catch (JSONException defect) { throw new IllegalStateException(defect); }
        writeState(state);
        return chosen;
    }

    private static Installed fallback(List<Installed> usable, Installed chosen) {
        Installed best = null;
        for (Installed bundle : usable) {
            if (bundle != chosen && (best == null || bundle.versionCode > best.versionCode)) best = bundle;
        }
        return best;
    }

    /** The web client reports that it rendered; the active bundle is trusted from now on. */
    synchronized void confirmActive() {
        JSONObject state = state();
        String active = state.optString("active", "");
        if (active.isEmpty()) return;
        try {
            JSONObject bundles = state.optJSONObject("bundles");
            if (bundles == null) state.put("bundles", bundles = new JSONObject());
            JSONObject record = bundles.optJSONObject(active);
            if (record == null) bundles.put(active, record = new JSONObject());
            record.put("confirmed", true).put("launches", 0);
        } catch (JSONException defect) { throw new IllegalStateException(defect); }
        writeState(state);
    }

    synchronized String activeRevision() {
        return state().optString("active", "");
    }

    synchronized Installed active() {
        String revision = activeRevision();
        return revision.isEmpty() ? null : installed(revision);
    }

    int runningVersionCode() {
        Installed active = active();
        return active == null ? builtInVersionCode : active.versionCode;
    }

    synchronized boolean isBad(String revision) {
        JSONObject bundles = state().optJSONObject("bundles");
        JSONObject record = bundles == null ? null : bundles.optJSONObject(revision);
        return record != null && record.optBoolean("bad", false);
    }

    synchronized Installed installed(String revision) {
        if (revision == null || !revision.matches("[a-f0-9]{40}")) return null;
        Installed bundle = read(new File(root, revision));
        return bundle != null && fits(bundle) ? bundle : null;
    }

    boolean fits(Installed bundle) {
        return shellId.equals(bundle.shellId) && bundle.versionCode > builtInVersionCode;
    }

    /** Downloads, verifies and unpacks a published bundle. Returns the existing bundle when it is already present. */
    Installed stage(AppUpdates.WebRelease release, Download download) throws IOException {
        if (!shellId.equals(release.shellId)) throw new IOException("The published web client needs a newer Kenan app. Use Update app to install the APK.");
        Installed existing = installed(release.revision);
        if (existing != null) return existing;
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot save the web update. Free some phone storage and retry.");
        File zip = new File(root, release.revision + ".zip.partial");
        File stage = new File(root, "." + release.revision + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(zip)) {
                long received = download.transfer("/v1/app-update/" + release.fileName, output, release.size, 180_000);
                if (received != release.size) throw new IOException("The web update download was incomplete. Retry Update app.");
                output.getFD().sync();
            }
            if (zip.length() != release.size) throw new IOException("The saved web update has the wrong size. Retry Update app.");
            if (!sha256(zip).equalsIgnoreCase(release.sha256)) throw new IOException("The web update failed its SHA-256 check. Retry Update app; if it fails again, ask for the release to be republished.");
            delete(stage);
            extract(zip, stage);
            if (!new File(stage, "index.html").isFile()) throw new IOException("The web update has no index.html. Ask for the release to be republished.");
            JSONObject marker = new JSONObject();
            try {
                marker.put("revision", release.revision).put("versionCode", release.versionCode).put("shellId", release.shellId)
                    .put("applicationId", BuildConfig.APPLICATION_ID).put("sha256", release.sha256);
            } catch (JSONException defect) { throw new IllegalStateException(defect); }
            writeAtomically(new File(stage, RELEASE_FILE), marker.toString().getBytes(StandardCharsets.UTF_8));
            File target = new File(root, release.revision);
            delete(target);
            if (!stage.renameTo(target)) throw new IOException("Cannot save the unpacked web update. Free some phone storage and retry.");
            Installed installed = read(target);
            if (installed == null) throw new IOException("The unpacked web update is unreadable. Retry Update app.");
            return installed;
        } finally {
            delete(zip);
            delete(stage);
        }
    }

    static void extract(File zip, File target) throws IOException {
        if (!target.mkdirs()) throw new IOException("Cannot create the web update directory. Free some phone storage and retry.");
        String base = target.getCanonicalPath() + File.separator;
        long total = 0;
        int count = 0;
        byte[] buffer = new byte[64 * 1024];
        try (ZipInputStream input = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.isEmpty() || name.startsWith("/") || name.contains("\\") || name.contains("\0")) throw new IOException("The web update contains an invalid path. Ask for the release to be republished.");
                for (String segment : name.split("/")) {
                    if (segment.equals("..") || segment.equals(".") ) throw new IOException("The web update contains an invalid path. Ask for the release to be republished.");
                }
                File file = new File(target, name);
                if (!file.getCanonicalPath().startsWith(base)) throw new IOException("The web update contains an invalid path. Ask for the release to be republished.");
                if (entry.isDirectory()) {
                    if (!file.isDirectory() && !file.mkdirs()) throw new IOException("Cannot create a web update directory. Free some phone storage and retry.");
                    continue;
                }
                if (name.equals(RELEASE_FILE)) throw new IOException("The web update contains a reserved file. Ask for the release to be republished.");
                if (++count > MAX_ENTRIES) throw new IOException("The web update has too many files. Ask for the release to be republished.");
                File parent = file.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create a web update directory. Free some phone storage and retry.");
                try (FileOutputStream output = new FileOutputStream(file)) {
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_EXTRACTED_BYTES) throw new IOException("The web update is too large once unpacked. Ask for the release to be republished.");
                        output.write(buffer, 0, read);
                    }
                    output.getFD().sync();
                }
            }
        }
        if (count == 0) throw new IOException("The web update is empty. Ask for the release to be republished.");
    }

    private Installed read(File directory) {
        File marker = new File(directory, RELEASE_FILE);
        if (!marker.isFile() || !directory.getName().matches("[a-f0-9]{40}")) return null;
        try {
            JSONObject json = new JSONObject(new String(readAll(marker), StandardCharsets.UTF_8));
            String revision = json.getString("revision");
            String shell = json.getString("shellId");
            int versionCode = json.getInt("versionCode");
            if (!revision.equals(directory.getName()) || !shell.matches("[a-f0-9]{16}") || versionCode < 1
                || !BuildConfig.APPLICATION_ID.equals(json.getString("applicationId"))
                || !new File(directory, "index.html").isFile()) return null;
            return new Installed(revision, versionCode, shell, directory);
        } catch (JSONException | IOException failure) {
            return null;
        }
    }

    private JSONObject state() {
        File file = new File(root, "state.json");
        if (!file.isFile()) return new JSONObject();
        try { return new JSONObject(new String(readAll(file), StandardCharsets.UTF_8)); }
        catch (JSONException | IOException failure) { return new JSONObject(); }
    }

    private void writeState(JSONObject state) {
        if (!root.isDirectory() && !root.mkdirs()) return;
        try { writeAtomically(new File(root, "state.json"), state.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (IOException ignored) { }
    }

    private static void writeAtomically(File file, byte[] bytes) throws IOException {
        File partial = new File(file.getPath() + ".partial");
        try (FileOutputStream output = new FileOutputStream(partial)) {
            output.write(bytes);
            output.getFD().sync();
        }
        if (!partial.renameTo(file)) throw new IOException("Cannot write " + file.getName());
    }

    private static byte[] readAll(File file) throws IOException {
        if (file.length() > 1024 * 1024) throw new IOException("File too large: " + file.getName());
        byte[] bytes = new byte[(int) file.length()];
        try (InputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
        }
        return bytes;
    }

    static String sha256(File file) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException defect) { throw new IllegalStateException(defect); }
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return hash.toString();
    }

    static void delete(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}

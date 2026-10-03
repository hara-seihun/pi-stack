package works.kenan.piremote.kenan;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

final class CrashReports {
    static void install(Context context) {
        File directory = new File(context.getFilesDir(), "diagnostics");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            Log.w("KenanDiagnostics", "Cannot create private diagnostics directory");
            return;
        }
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try (PrintWriter out = new PrintWriter(new OutputStreamWriter(new FileOutputStream(new File(directory, "last-crash.txt")), StandardCharsets.UTF_8))) {
                out.println("time=" + System.currentTimeMillis() + " version=" + BuildConfig.VERSION_CODE
                    + " revision=" + BuildConfig.RELEASE_REVISION + " thread=" + thread.getName());
                error.printStackTrace(out);
            } catch (Exception failure) { Log.w("KenanDiagnostics", "Could not retain crash", failure); }
            finally {
                if (previous != null) previous.uncaughtException(thread, error);
                else { Process.killProcess(Process.myPid()); System.exit(10); }
            }
        });
        new Thread(() -> capture(context, directory), "kenan-diagnostics").start();
    }

    private static void capture(Context context, File directory) {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                JSONArray exits = new JSONArray();
                for (ApplicationExitInfo exit : context.getSystemService(ActivityManager.class)
                    .getHistoricalProcessExitReasons(context.getPackageName(), 0, 8)) {
                    exits.put(new JSONObject().put("time", exit.getTimestamp()).put("reason", exit.getReason())
                        .put("status", exit.getStatus()).put("description", exit.getDescription())
                        .put("pssKiB", exit.getPss()).put("rssKiB", exit.getRss()));
                }
                try (FileOutputStream out = new FileOutputStream(new File(directory, "process-exits.json"))) {
                    out.write(exits.toString(2).getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception failure) { Log.w("KenanDiagnostics", "Could not retain process exits", failure); }
        }
        // Android restricts this to our UID. Keep the crash buffer, not chat or audio logs.
        java.lang.Process logcat = null;
        try {
            logcat = new ProcessBuilder("logcat", "--uid=" + Process.myUid(), "-b", "crash", "-d", "-t", "200")
                .redirectOutput(new File(directory, "android-crashes.txt")).redirectErrorStream(true).start();
            if (!logcat.waitFor(2, TimeUnit.SECONDS)) logcat.destroyForcibly();
        } catch (Exception failure) { Log.w("KenanDiagnostics", "Could not retain Android crash buffer", failure); }
        finally { if (logcat != null && logcat.isAlive()) logcat.destroyForcibly(); }
    }
}

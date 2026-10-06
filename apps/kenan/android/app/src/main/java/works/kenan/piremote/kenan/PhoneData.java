package works.kenan.piremote.kenan;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.admin.DevicePolicyManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.ComponentName;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.CalendarContract;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

public final class PhoneData {
    public static final int MAX_FILE_BYTES = 1024 * 1024;
    private final Context context;
    private final JSONObject args;
    private final long deadline;
    private final BooleanSupplier authorized;

    private PhoneData(Context context, JSONObject args, long deadline, BooleanSupplier authorized) {
        this.context = context.getApplicationContext();
        this.args = args == null ? new JSONObject() : args;
        this.deadline = deadline;
        this.authorized = authorized;
    }

    public static boolean supports(String command) {
        return NativeState.parse(NativeState.DataCommand.class, command).isPresent();
    }

    public static JSONObject dispatch(Context context, String command, JSONObject args, long deadline) {
        return dispatch(context, command, args, deadline, () -> true);
    }

    public static JSONObject dispatch(Context context, String command, JSONObject args, long deadline, BooleanSupplier authorized) {
        PhoneData data = new PhoneData(context, args, deadline, authorized);
        try {
            data.check();
            if (!supports(command)) return failure("unsupported", "Unknown data command: " + command);
            Object result = data.execute(command);
            return json("ok", true, "result", result);
        } catch (CommandFailure e) {
            return failure(e.code, e.getMessage());
        } catch (SecurityException e) {
            return failure("permission_denied", e.getMessage());
        } catch (JSONException | IllegalArgumentException e) {
            return failure("invalid_args", e.getMessage());
        } catch (android.os.OperationCanceledException e) {
            return failure("timeout", "Content provider exceeded command deadline");
        } catch (IOException e) {
            return failure("io_error", e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return failure("cancelled", "Command worker interrupted");
        } catch (Exception e) {
            return failure("operation_failed", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private Object execute(String command) throws Exception {
        if (command.startsWith("files.") && Build.VERSION.SDK_INT < 26) throw new CommandFailure("unsupported", "File operations require Android 8 or later");
        return switch (NativeState.require(NativeState.DataCommand.class, command)) {
            case DEVICE_INFO -> deviceInfo();
            case APPS_LIST -> apps();
            case FILES_LIST -> filesList();
            case FILES_READ -> filesRead();
            case FILES_WRITE -> filesWrite();
            case FILES_MKDIR -> filesMkdir();
            case FILES_DELETE -> filesDelete();
            case CONTACTS_LIST -> contactsList();
            case CONTACTS_GET -> contactDetails();
            case CONTACTS_INSERT -> contactsInsert();
            case CALENDAR_LIST -> calendars();
            case CALENDAR_EVENTS -> events();
            case CALENDAR_INSTANCES -> instances();
            case CALENDAR_INSERT -> calendarInsert();
            case LOCATION_GET -> location();
            case SMS_LIST -> smsList();
            case SMS_SEND -> smsSend();
            case CALLS_LIST -> calls();
            case CALL_DIAL -> dial();
            case USAGE_QUERY -> usage();
            case SETTINGS_GET -> setting(false);
            case SETTINGS_PUT -> setting(true);
            case DEVICE_LOCK -> admin(NativeState.AdminCommand.LOCK);
            case DEVICE_REBOOT -> admin(NativeState.AdminCommand.REBOOT);
            case DEVICE_WIPE -> admin(NativeState.AdminCommand.WIPE);
            case APPS_SUSPEND -> admin(NativeState.AdminCommand.SUSPEND);
            case PERMISSIONS_GRANT -> admin(NativeState.AdminCommand.GRANT);
        };
    }

    public static JSONObject capabilities(Context c) {
        DevicePolicyManager dpm = c.getSystemService(DevicePolicyManager.class);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(c.getPackageName());
        boolean location = granted(c, Manifest.permission.ACCESS_COARSE_LOCATION) && granted(c, Manifest.permission.ACCESS_FINE_LOCATION);
        return json("allFiles", Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager(),
            "contacts", granted(c, Manifest.permission.READ_CONTACTS) && granted(c, Manifest.permission.WRITE_CONTACTS),
            "calendar", granted(c, Manifest.permission.READ_CALENDAR) && granted(c, Manifest.permission.WRITE_CALENDAR),
            "location", location,
            "backgroundLocation", location && (Build.VERSION.SDK_INT < 29 || granted(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION)),
            "sms", granted(c, Manifest.permission.READ_SMS) && granted(c, Manifest.permission.SEND_SMS),
            "callLog", granted(c, Manifest.permission.READ_CALL_LOG), "phone", granted(c, Manifest.permission.CALL_PHONE),
            "camera", granted(c, Manifest.permission.CAMERA), "microphone", granted(c, Manifest.permission.RECORD_AUDIO),
            "usage", usageGranted(c), "writeSettings", Settings.System.canWrite(c),
            "secureSettings", granted(c, Manifest.permission.WRITE_SECURE_SETTINGS), "deviceOwner", owner,
            "deviceAdmin", dpm != null && dpm.isAdminActive(new ComponentName(c, PhoneAdminReceiver.class)),
            "readContacts", granted(c, Manifest.permission.READ_CONTACTS), "writeContacts", granted(c, Manifest.permission.WRITE_CONTACTS),
            "readCalendar", granted(c, Manifest.permission.READ_CALENDAR), "writeCalendar", granted(c, Manifest.permission.WRITE_CALENDAR),
            "readSms", granted(c, Manifest.permission.READ_SMS), "sendSms", granted(c, Manifest.permission.SEND_SMS));
    }

    private static boolean granted(Context c, String permission) {
        return c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean usageGranted(Context c) {
        AppOpsManager ops = c.getSystemService(AppOpsManager.class);
        return ops != null && ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
            android.os.Process.myUid(), c.getPackageName()) == AppOpsManager.MODE_ALLOWED;
    }

    private void check() throws CommandFailure {
        if (!authorized.getAsBoolean()) throw new CommandFailure("cancelled", "Phone identity or enabled state changed");
        if (System.currentTimeMillis() >= deadline) throw new CommandFailure("timeout", "Command deadline expired");
        if (Thread.currentThread().isInterrupted()) throw new CommandFailure("cancelled", "Command worker interrupted");
    }

    private void require(String permission) throws CommandFailure {
        check();
        if (!granted(context, permission)) throw new CommandFailure("permission_denied", "Requires " + permission);
    }

    private void confirm() throws CommandFailure {
        if (!Boolean.TRUE.equals(args.opt("confirm"))) throw new CommandFailure("confirmation_required", "This command requires confirm:true");
    }

    private String text(String key) throws JSONException {
        Object value = args.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) throw new JSONException(key + " must be a nonempty string");
        if (((String) value).length() > 16384) throw new JSONException(key + " exceeds 16384 characters");
        return (String) value;
    }

    private long number(String key, long fallback, long min, long max) throws JSONException {
        if (!args.has(key)) return fallback;
        Object v = args.get(key);
        if (!(v instanceof Number)) throw new JSONException(key + " must be an integer");
        long value = ((Number) v).longValue();
        if (((Number) v).doubleValue() != value || value < min || value > max) throw new JSONException(key + " must be between " + min + " and " + max);
        return value;
    }

    private int limit() throws JSONException { return (int) number("limit", 100, 1, 500); }
    private int offset() throws JSONException { return (int) number("offset", 0, 0, 100000); }

    private JSONObject deviceInfo() throws Exception {
        check();
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        return json("manufacturer", Build.MANUFACTURER, "model", Build.MODEL, "android", Build.VERSION.RELEASE,
            "sdk", Build.VERSION.SDK_INT, "package", context.getPackageName(), "capabilities", capabilities(context),
            "filesDir", context.getFilesDir().getAbsolutePath(), "externalFilesDir", context.getExternalFilesDir(null),
            "battery", battery == null ? JSONObject.NULL : json("level", battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                "scale", battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1), "status", battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1),
                "plugged", battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)));
    }

    private JSONObject apps() throws Exception {
        int limit = limit(), offset = offset();
        check();
        PackageManager pm = context.getPackageManager();
        List<PackageInfo> packages = pm.getInstalledPackages(0);
        packages.sort((a, b) -> a.packageName.compareTo(b.packageName));
        JSONArray items = new JSONArray();
        String filter = args.optString("query", "").toLowerCase(java.util.Locale.ROOT);
        int matched = 0;
        boolean more = false;
        for (PackageInfo p : packages) {
            check();
            ApplicationInfo app = p.applicationInfo;
            String label = app == null ? p.packageName : pm.getApplicationLabel(app).toString();
            if (!filter.isEmpty() && !(p.packageName + " " + label).toLowerCase(java.util.Locale.ROOT).contains(filter)) continue;
            if (matched++ < offset) continue;
            if (items.length() == limit) { more = true; break; }
            items.put(json("package", p.packageName, "label", label, "version", p.versionName,
                "versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode,
                "enabled", app != null && app.enabled, "system", app != null && (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0));
        }
        return page(items, offset, more);
    }

    private Path path() throws Exception {
        String value = args.has("path") ? text("path") : context.getFilesDir().getAbsolutePath();
        Path path = java.nio.file.Paths.get(value);
        if (!path.isAbsolute()) path = context.getFilesDir().toPath().resolve(path);
        return path.normalize();
    }

    private JSONObject filesList() throws Exception {
        Path path = path();
        int limit = limit(), offset = offset(), skipped = 0;
        JSONArray items = new JSONArray();
        boolean more = false;
        check();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(path)) {
            for (Path entry : entries) {
                check();
                if (skipped++ < offset) continue;
                if (items.length() == limit) { more = true; break; }
                java.nio.file.attribute.BasicFileAttributes attr = Files.readAttributes(entry,
                    java.nio.file.attribute.BasicFileAttributes.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
                items.put(json("name", entry.getFileName().toString(), "path", entry.toString(),
                    "directory", attr.isDirectory(), "symlink", attr.isSymbolicLink(), "size", attr.size(), "modified", attr.lastModifiedTime().toMillis()));
            }
        }
        return json("path", path.toString(), "items", items, "nextOffset", more ? offset + items.length() : JSONObject.NULL,
            "order", "filesystem; pagination assumes unchanged directory");
    }

    private JSONObject filesRead() throws Exception {
        Path path = path();
        check();
        if (!Files.isRegularFile(path)) throw new CommandFailure("invalid_args", "Read requires an accessible regular file");
        int max = (int) number("maxBytes", MAX_FILE_BYTES, 1, MAX_FILE_BYTES);
        long offset = number("offset", 0, 0, Long.MAX_VALUE);
        check();
        try (RandomAccessFile file = new RandomAccessFile(path.toFile(), "r")) {
            long size = file.length();
            file.seek(offset);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            while (out.size() < max) {
                check();
                int n = file.read(buffer, 0, Math.min(buffer.length, max - out.size()));
                if (n < 0) break;
                out.write(buffer, 0, n);
            }
            return json("path", path.toString(), "base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP),
                "bytes", out.size(), "size", size, "offset", offset, "nextOffset", offset + out.size() < size ? offset + out.size() : JSONObject.NULL);
        }
    }

    private JSONObject filesWrite() throws Exception {
        text("path");
        Path path = path();
        check();
        if (Files.exists(path) && !Files.isRegularFile(path)) throw new CommandFailure("invalid_args", "Write requires a regular file path");
        Object encoded = args.get("base64");
        if (!(encoded instanceof String) || ((String) encoded).length() > ((MAX_FILE_BYTES + 2) / 3) * 4 + 8) throw new JSONException("base64 exceeds 1 MiB decoded limit");
        byte[] bytes = Base64.decode((String) encoded, Base64.DEFAULT);
        if (bytes.length > MAX_FILE_BYTES) throw new JSONException("Decoded file exceeds 1 MiB");
        boolean overwrite = args.optBoolean("overwrite", false);
        if (overwrite) confirm();
        check();
        Files.write(path, bytes, StandardOpenOption.WRITE, overwrite ? StandardOpenOption.CREATE : StandardOpenOption.CREATE_NEW,
            overwrite ? StandardOpenOption.TRUNCATE_EXISTING : StandardOpenOption.WRITE);
        return json("path", path.toString(), "bytes", bytes.length, "written", true);
    }

    private JSONObject filesMkdir() throws Exception {
        text("path");
        Path path = path();
        check();
        if (args.optBoolean("parents", false)) Files.createDirectories(path); else Files.createDirectory(path);
        return json("path", path.toString(), "directory", true);
    }

    private JSONObject filesDelete() throws Exception {
        confirm();
        text("path");
        if (args.optBoolean("recursive", false)) throw new JSONException("Recursive deletion is not supported");
        Path path = path();
        check();
        Files.delete(path);
        return json("path", path.toString(), "deleted", true);
    }

    private JSONObject query(Uri uri, String[] columns, String selection, String[] values, String order) throws Exception {
        int limit = limit(), offset = offset();
        JSONArray items = new JSONArray();
        check();
        CancellationSignal cancellation = new CancellationSignal();
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable expire = cancellation::cancel;
        handler.postDelayed(expire, Math.max(1, deadline - System.currentTimeMillis()));
        try (Cursor cursor = context.getContentResolver().query(uri, columns, selection, values, order, cancellation)) {
            if (cursor == null) throw new CommandFailure("provider_unavailable", "Provider returned no cursor: " + uri);
            int skipped = 0;
            while (skipped < offset && cursor.moveToNext()) { check(); skipped++; }
            int outputBudget = 4 * 1024 * 1024;
            boolean budgetFull = false;
            while (items.length() < limit && cursor.moveToNext()) {
                check();
                JSONObject row = new JSONObject();
                JSONArray truncated = new JSONArray();
                for (int i = 0; i < cursor.getColumnCount(); i++) {
                    Object value = switch (NativeState.CursorType.require(cursor.getType(i))) {
                        case INTEGER -> cursor.getLong(i);
                        case FLOAT -> cursor.getDouble(i);
                        case NULL -> JSONObject.NULL;
                        case BLOB -> "[binary]";
                        case STRING -> {
                            String s = cursor.getString(i);
                            if (s.length() > 16384) truncated.put(cursor.getColumnName(i));
                            yield s.length() > 16384 ? s.substring(0, 16384) : s;
                        }
                    };
                    row.put(cursor.getColumnName(i), value);
                }
                if (truncated.length() > 0) row.put("_truncatedColumns", truncated);
                int cost = row.toString().length() * 3;
                if (cost > outputBudget) { budgetFull = true; break; }
                outputBudget -= cost;
                items.put(row);
            }
            check();
            return page(items, offset, budgetFull || cursor.moveToNext());
        } finally { handler.removeCallbacks(expire); }
    }

    private JSONObject contactsList() throws Exception {
        require(Manifest.permission.READ_CONTACTS);
        String filter = args.optString("query", "");
        return query(ContactsContract.Contacts.CONTENT_URI,
            new String[]{"_id", "display_name", "has_phone_number", "lookup"},
            filter.isEmpty() ? null : "display_name LIKE ?", filter.isEmpty() ? null : new String[]{"%" + filter + "%"},
            "display_name ASC, _id ASC");
    }

    private JSONObject contactDetails() throws Exception {
        require(Manifest.permission.READ_CONTACTS);
        long id = number("contactId", -1, 1, Long.MAX_VALUE);
        if (id < 1) throw new JSONException("contactId is required");
        return query(ContactsContract.Data.CONTENT_URI,
            new String[]{"_id", "contact_id", "mimetype", "data1", "data2", "data3"},
            "contact_id=?", new String[]{Long.toString(id)}, "mimetype ASC, _id ASC");
    }

    private JSONObject contactsInsert() throws Exception {
        require(Manifest.permission.WRITE_CONTACTS);
        String name = text("name");
        ArrayList<ContentProviderOperation> operations = new ArrayList<>();
        operations.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
            .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build());
        operations.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name).build());
        if (args.has("phone")) operations.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, text("phone"))
            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE).build());
        if (args.has("email")) operations.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, text("email"))
            .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_HOME).build());
        check();
        ContentProviderResult[] result = context.getContentResolver().applyBatch(ContactsContract.AUTHORITY, operations);
        return json("rawContactUri", result[0].uri.toString(), "inserted", true);
    }

    private JSONObject calendars() throws Exception {
        require(Manifest.permission.READ_CALENDAR);
        return query(CalendarContract.Calendars.CONTENT_URI,
            new String[]{"_id", "calendar_displayName", "account_name", "account_type", "calendar_access_level", "visible"}, null, null, "_id ASC");
    }

    private JSONObject events() throws Exception {
        require(Manifest.permission.READ_CALENDAR);
        ArrayList<String> clauses = new ArrayList<>();
        ArrayList<String> values = new ArrayList<>();
        if (args.has("calendarId")) { clauses.add("calendar_id=?"); values.add(Long.toString(number("calendarId", 0, 1, Long.MAX_VALUE))); }
        if (args.has("start")) { clauses.add("(dtend>=? OR dtend IS NULL)"); values.add(Long.toString(number("start", 0, 0, Long.MAX_VALUE))); }
        if (args.has("end")) { clauses.add("dtstart<=?"); values.add(Long.toString(number("end", 0, 0, Long.MAX_VALUE))); }
        return query(CalendarContract.Events.CONTENT_URI,
            new String[]{"_id", "calendar_id", "title", "description", "eventLocation", "dtstart", "dtend", "eventTimezone", "allDay", "rrule"},
            clauses.isEmpty() ? null : String.join(" AND ", clauses), values.toArray(new String[0]), "dtstart ASC, _id ASC");
    }

    private JSONObject instances() throws Exception {
        require(Manifest.permission.READ_CALENDAR);
        long start = number("start", -1, 0, Long.MAX_VALUE);
        long end = number("end", -1, 1, Long.MAX_VALUE);
        if (start < 0 || end <= start || end - start > 366L * 86400000) {
            throw new JSONException("start/end Unix ms required; range must be positive and at most 366 days");
        }
        Uri.Builder builder = CalendarContract.Instances.CONTENT_URI.buildUpon();
        android.content.ContentUris.appendId(builder, start);
        android.content.ContentUris.appendId(builder, end);
        return query(builder.build(),
            new String[]{"event_id", "calendar_id", "title", "description", "eventLocation", "begin", "end", "allDay"},
            args.has("calendarId") ? "calendar_id=?" : null,
            args.has("calendarId") ? new String[]{Long.toString(number("calendarId", -1, 1, Long.MAX_VALUE))} : null,
            "begin ASC, event_id ASC");
    }

    private JSONObject calendarInsert() throws Exception {
        require(Manifest.permission.WRITE_CALENDAR);
        long calendar = number("calendarId", -1, 1, Long.MAX_VALUE);
        long start = number("start", -1, 0, Long.MAX_VALUE);
        long end = number("end", -1, 0, Long.MAX_VALUE);
        if (calendar < 1 || start < 0 || end <= start) throw new JSONException("calendarId, start and end required; end must exceed start (Unix ms)");
        ContentValues values = new ContentValues();
        values.put(CalendarContract.Events.CALENDAR_ID, calendar);
        values.put(CalendarContract.Events.TITLE, text("title"));
        values.put(CalendarContract.Events.DTSTART, start);
        values.put(CalendarContract.Events.DTEND, end);
        values.put(CalendarContract.Events.EVENT_TIMEZONE, args.optString("timezone", TimeZone.getDefault().getID()));
        values.put(CalendarContract.Events.ALL_DAY, args.optBoolean("allDay", false) ? 1 : 0);
        if (args.has("description")) values.put(CalendarContract.Events.DESCRIPTION, text("description"));
        if (args.has("location")) values.put(CalendarContract.Events.EVENT_LOCATION, text("location"));
        check();
        Uri uri = context.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, values);
        if (uri == null) throw new CommandFailure("provider_unavailable", "Calendar insert returned no URI");
        return json("uri", uri.toString(), "inserted", true);
    }

    private JSONObject location() throws Exception {
        check();
        boolean fine = granted(context, Manifest.permission.ACCESS_FINE_LOCATION);
        if (!fine && !granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)) throw new CommandFailure("permission_denied", "Requires coarse or fine location");
        if (Looper.myLooper() == Looper.getMainLooper()) throw new CommandFailure("operation_failed", "location.get must run on command worker");
        LocationManager manager = context.getSystemService(LocationManager.class);
        if (manager == null || (Build.VERSION.SDK_INT >= 28 && !manager.isLocationEnabled())) throw new CommandFailure("unavailable", "Location is disabled");
        String provider = args.optString("provider", "");
        if (provider.isEmpty()) provider = fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
        if (!manager.getAllProviders().contains(provider) || !manager.isProviderEnabled(provider)) throw new CommandFailure("unavailable", "Location provider unavailable: " + provider);
        long maxAge = number("maxAgeMs", 60000, 0, 86400000);
        long timeout = number("timeoutMs", 12000, 1, 15000);
        check();
        Location cached = manager.getLastKnownLocation(provider);
        if (!args.optBoolean("fresh", false) && cached != null && android.os.SystemClock.elapsedRealtimeNanos() - cached.getElapsedRealtimeNanos() <= maxAge * 1000000) {
            check();
            return locationJson(cached, true);
        }
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Location> current = new AtomicReference<>();
        LocationListener listener = new LocationListener() {
            @Override public void onLocationChanged(Location value) { if (authorized.getAsBoolean() && System.currentTimeMillis() < deadline) current.set(value); latch.countDown(); }
            @Override public void onProviderDisabled(String p) { latch.countDown(); }
            @Override public void onProviderEnabled(String p) {}
            @Override public void onStatusChanged(String p, int status, android.os.Bundle extras) {}
        };
        check();
        try {
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper());
            latch.await(Math.max(1, Math.min(timeout, deadline - System.currentTimeMillis())), TimeUnit.MILLISECONDS);
            check();
            if (current.get() == null) throw new CommandFailure("unavailable", "No location fix before timeout");
            return locationJson(current.get(), false);
        } finally { manager.removeUpdates(listener); }
    }

    private JSONObject locationJson(Location l, boolean cached) {
        return json("latitude", l.getLatitude(), "longitude", l.getLongitude(), "accuracy", l.hasAccuracy() ? l.getAccuracy() : JSONObject.NULL,
            "altitude", l.hasAltitude() ? l.getAltitude() : JSONObject.NULL, "time", l.getTime(), "provider", l.getProvider(), "cached", cached);
    }

    private JSONObject smsList() throws Exception {
        require(Manifest.permission.READ_SMS);
        return query(Telephony.Sms.CONTENT_URI, new String[]{"_id", "thread_id", "address", "body", "date", "type", "read"},
            args.has("address") ? "address=?" : null, args.has("address") ? new String[]{text("address")} : null, "date DESC, _id DESC");
    }

    private JSONObject smsSend() throws Exception {
        confirm();
        require(Manifest.permission.SEND_SMS);
        String to = text("to"), body = text("text");
        SmsManager manager = Build.VERSION.SDK_INT >= 31 ? context.getSystemService(SmsManager.class) : SmsManager.getDefault();
        if (args.has("subscriptionId")) manager = SmsManager.getSmsManagerForSubscriptionId((int) number("subscriptionId", 0, 0, Integer.MAX_VALUE));
        if (manager == null) throw new CommandFailure("unavailable", "No SMS service");
        ArrayList<String> parts = manager.divideMessage(body);
        if (parts.size() > 10) throw new JSONException("SMS exceeds 10 segments");
        check();
        if (parts.size() == 1) manager.sendTextMessage(to, null, body, null, null);
        else manager.sendMultipartTextMessage(to, null, parts, null, null);
        return json("status", "submitted", "segments", parts.size(), "delivered", JSONObject.NULL,
            "note", "Submitted to Android telephony; carrier send and delivery are not confirmed");
    }

    private JSONObject calls() throws Exception {
        require(Manifest.permission.READ_CALL_LOG);
        return query(CallLog.Calls.CONTENT_URI, new String[]{"_id", "number", "name", "date", "duration", "type"},
            args.has("number") ? "number=?" : null, args.has("number") ? new String[]{text("number")} : null, "date DESC, _id DESC");
    }

    private JSONObject dial() throws Exception {
        confirm();
        require(Manifest.permission.CALL_PHONE);
        Intent intent = new Intent(Intent.ACTION_CALL, Uri.fromParts("tel", text("number"), null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        check();
        context.startActivity(intent);
        return json("status", "requested", "note", "Android may restrict background activity starts; this does not confirm a connected call");
    }

    private JSONObject usage() throws Exception {
        check();
        if (!usageGranted(context)) throw new CommandFailure("permission_denied", "Requires Usage access special permission");
        long end = number("end", System.currentTimeMillis(), 1, Long.MAX_VALUE);
        long start = number("start", end - 86400000, 0, Long.MAX_VALUE);
        if (start >= end || end - start > 366L * 86400000) throw new JSONException("Usage range must be positive and at most 366 days");
        int limit = limit(), offset = offset();
        check();
        UsageStatsManager manager = context.getSystemService(UsageStatsManager.class);
        List<UsageStats> stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_BEST, start, end);
        if (stats == null) throw new CommandFailure("unavailable", "Usage stats unavailable (device may be locked)");
        stats.sort((a, b) -> Long.compare(b.getLastTimeUsed(), a.getLastTimeUsed()));
        JSONArray items = new JSONArray();
        int skipped = 0;
        boolean more = false;
        for (UsageStats s : stats) {
            check();
            if (args.has("package") && !text("package").equals(s.getPackageName())) continue;
            if (skipped++ < offset) continue;
            if (items.length() == limit) { more = true; break; }
            items.put(json("package", s.getPackageName(), "firstTime", s.getFirstTimeStamp(), "lastTime", s.getLastTimeStamp(),
                "lastUsed", s.getLastTimeUsed(), "foregroundMs", s.getTotalTimeInForeground()));
        }
        return json("start", start, "end", end, "items", items, "nextOffset", more ? offset + items.length() : JSONObject.NULL,
            "note", "Android bucket aggregates can extend beyond the requested time boundaries");
    }

    private JSONObject setting(boolean write) throws Exception {
        NativeState.SettingsNamespace namespace = NativeState.require(NativeState.SettingsNamespace.class, args.optString("namespace", "system"));
        String key = text("key");
        String value = null;
        if (write) {
            confirm();
            if (!args.has("value")) throw new JSONException("value is required (string or null)");
            Object v = args.get("value");
            if (v != JSONObject.NULL && !(v instanceof String)) throw new JSONException("value must be string or null");
            value = v == JSONObject.NULL ? null : (String) v;
            if (value != null && value.length() > 16384) throw new JSONException("value exceeds 16384 characters");
            boolean permission = switch (namespace) {
                case SYSTEM -> {
                    if (!Settings.System.canWrite(context)) throw new CommandFailure("permission_denied", "Requires Modify system settings special access");
                    yield true;
                }
                case SECURE, GLOBAL -> { require(Manifest.permission.WRITE_SECURE_SETTINGS); yield true; }
            };
        }
        check();
        if (write) {
            boolean written = switch (namespace) {
                case SYSTEM -> Settings.System.putString(context.getContentResolver(), key, value);
                case SECURE -> Settings.Secure.putString(context.getContentResolver(), key, value);
                case GLOBAL -> Settings.Global.putString(context.getContentResolver(), key, value);
            };
            if (!written) throw new CommandFailure("operation_failed", "Android settings provider rejected write");
        } else value = switch (namespace) {
            case SYSTEM -> Settings.System.getString(context.getContentResolver(), key);
            case SECURE -> Settings.Secure.getString(context.getContentResolver(), key);
            case GLOBAL -> Settings.Global.getString(context.getContentResolver(), key);
        };
        return write ? json("namespace", namespace.wire(), "key", key, "written", true) : json("namespace", namespace.wire(), "key", key, "value", value);
    }

    private JSONObject admin(NativeState.AdminCommand command) throws Exception {
        check();
        DevicePolicyManager manager = context.getSystemService(DevicePolicyManager.class);
        ComponentName admin = new ComponentName(context, PhoneAdminReceiver.class);
        if (manager == null) throw new CommandFailure("unsupported", "Device policy service unavailable");
        if (command != NativeState.AdminCommand.LOCK && !manager.isDeviceOwnerApp(context.getPackageName()))
            throw new CommandFailure("permission_denied", "Requires Device Owner provisioning, not ordinary Device Admin");
        return switch (command) {
            case LOCK -> {
                if (!manager.isAdminActive(admin)) throw new CommandFailure("permission_denied", "Requires explicitly enrolled Device Admin");
                check(); manager.lockNow();
                yield json("status", "requested");
            }
            case REBOOT -> {
                confirm(); check(); manager.reboot(admin); yield json("status", "requested");
            }
            case WIPE -> {
                confirm(); check();
                if (Build.VERSION.SDK_INT >= 34) manager.wipeDevice(0); else manager.wipeData(0);
                yield json("status", "requested", "note", "Factory reset; connection may disappear before acknowledgment");
            }
            case SUSPEND -> {
                confirm();
                JSONArray input = args.getJSONArray("packages");
                if (input.length() < 1 || input.length() > 100) throw new JSONException("packages must contain 1..100 package names");
                String[] packages = new String[input.length()];
                for (int i = 0; i < packages.length; i++) {
                    if (!(input.get(i) instanceof String) || input.getString(i).isEmpty()) throw new JSONException("Each package must be a nonempty string");
                    packages[i] = input.getString(i);
                }
                if (!(args.opt("suspended") instanceof Boolean)) throw new JSONException("suspended boolean required");
                check();
                String[] failed = manager.setPackagesSuspended(admin, packages, args.getBoolean("suspended"));
                yield json("suspended", args.getBoolean("suspended"), "requested", input, "failedPackages", new JSONArray(failed), "allApplied", failed.length == 0);
            }
            case GRANT -> {
                String pkg = text("package"), permission = text("permission"), state = args.optString("state", "granted");
                int grant = switch (NativeState.require(NativeState.PermissionGrant.class, state)) {
                    case GRANTED -> DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED;
                    case DENIED -> { confirm(); yield DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED; }
                    case DEFAULT -> { confirm(); yield DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT; }
                };
                check();
                if (!manager.setPermissionGrantState(admin, pkg, permission, grant)) throw new CommandFailure("operation_failed", "Device policy rejected permission change");
                yield json("package", pkg, "permission", permission, "state", state, "applied", true);
            }
        };
    }

    private static JSONObject page(JSONArray items, int offset, boolean more) {
        return json("items", items, "nextOffset", more ? offset + items.length() : JSONObject.NULL,
            "stringLimit", 16384);
    }

    private static JSONObject failure(String code, String message) {
        return json("ok", false, "error", json("code", code, "message", message == null ? code : message));
    }

    private static JSONObject json(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]);
            return result;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private static final class CommandFailure extends Exception {
        final String code;
        CommandFailure(String code, String message) { super(message); this.code = code; }
    }
}

package works.kenan.piremote.kenan;

import java.util.Optional;

/** Closed native protocol domains. Unknown wire values never become a legitimate state. */
final class NativeState {
    interface Value { String wire(); }
    interface Action { void run() throws Exception; }

    static <E extends Enum<E> & Value> Optional<E> parse(Class<E> domain, String wire) {
        for (E value : domain.getEnumConstants()) if (value.wire().equals(wire)) return Optional.of(value);
        return Optional.empty();
    }

    static <E extends Enum<E> & Value> E require(Class<E> domain, String wire) {
        return parse(domain, wire).orElseThrow(() -> new IllegalArgumentException("Invalid " + domain.getSimpleName() + ": " + wire));
    }

    enum BackResult implements Value {
        HANDLED("true"), UNHANDLED("false");
        private final String wire;
        BackResult(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum UpdateKind implements Value {
        WEB("web"), APK("apk");
        private final String wire;
        UpdateKind(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum PhoneFailure implements Value {
        SESSION_EXPIRED("session_expired"), PUBLIC_SIGN_IN_REQUIRED("public_sign_in_required"),
        PERMISSION_DENIED("permission_denied"), DISCONNECTED("disconnected"), PROTOCOL_ERROR("protocol_error"), INTERNAL_ERROR("internal_error");
        private final String wire;
        PhoneFailure(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum ServiceIntent implements Value {
        START("start"), DISABLE("disable"), OVERLAY("overlay");
        private final String wire;
        ServiceIntent(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum Haptic implements Value {
        SELECT("select"), PRESS("press"), RELEASE("release"), CONFIRM("confirm"), REJECT("reject");
        private final String wire;
        Haptic(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum WriteSetup implements Value {
        MICROPHONE("microphone"), NOTIFICATION("notification"), OVERLAY("overlay"), ACCESSIBILITY("accessibility"),
        BATTERY("battery"), ENABLED("enabled"), KEYBOARD("keyboard");
        private final String wire;
        WriteSetup(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum PhoneSetup implements Value {
        CONTACTS("contacts"), CALENDAR("calendar"), LOCATION("location"), BACKGROUND_LOCATION("backgroundLocation"),
        SMS("sms"), CALL_LOG("callLog"), PHONE("phone"), CAMERA("camera"), MICROPHONE("microphone"), NOTIFICATIONS("notifications"),
        ACCESSIBILITY("accessibility"), WRITE_ACCESSIBILITY("writeAccessibility"), NOTIFICATION_ACCESS("notificationAccess"),
        OVERLAY("overlay"), BATTERY("battery"), ALL_FILES("allFiles"), USAGE("usage"), WRITE_SETTINGS("writeSettings"),
        INSTALL_PACKAGES("installPackages"), DEVICE_ADMIN("deviceAdmin"), DEVICE_OWNER("deviceOwner"), SECURE_SETTINGS("secureSettings");
        private final String wire;
        PhoneSetup(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum WriteEvent implements Value {
        PARTIAL("partial"), FINAL("final"), ERROR("error");
        private final String wire;
        WriteEvent(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum RewriteStatus implements Value {
        APPLIED("applied"), UNCHANGED("unchanged"), GUARDED("guarded"), UNAVAILABLE("unavailable");
        private final String wire;
        RewriteStatus(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum UnavailableRewrite implements Value {
        WARMING("warming"), WARMUP_FAILED("warmup_failed"), QUEUE_BUSY("queue_busy"),
        RUNTIME_CLOSED("runtime_closed"), INFERENCE_FAILED("inference_failed");
        private final String wire;
        UnavailableRewrite(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum PhoneFrame implements Value {
        COMMAND("command"), OVERLAY_ACK("overlay.ack"), READY("ready");
        private final String wire;
        PhoneFrame(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum OverlayAnimation implements Value {
        IDLE("idle"), THINKING("thinking"), WORKING("working");
        private final String wire;
        OverlayAnimation(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum OverlayCommand implements Value {
        SHOW("overlay.show"), HIDE("overlay.hide"), CLEAR("overlay.clear"), STATE("overlay.state"),
        MOVE("overlay.move"), POINT("overlay.point"), SAY("overlay.say");
        private final String wire;
        OverlayCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum AccessibilityCommand implements Value {
        TREE("ui.tree"), TAP("ui.tap"), SWIPE("ui.swipe"), TEXT("ui.text"), ACTION("ui.action"), GLOBAL("ui.global"), CAPTURE("screen.capture");
        private final String wire;
        AccessibilityCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum NodeAction implements Value {
        CLICK("click"), LONG_CLICK("longClick"), LONG_CLICK_ALIAS("long_click"), FOCUS("focus"),
        SCROLL_FORWARD("scrollForward"), SCROLL_FORWARD_ALIAS("scroll_forward"),
        SCROLL_BACKWARD("scrollBackward"), SCROLL_BACKWARD_ALIAS("scroll_backward"), PASTE("paste");
        private final String wire;
        NodeAction(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum GlobalAction implements Value {
        BACK("back"), HOME("home"), RECENTS("recents"), NOTIFICATIONS("notifications"), QUICK_SETTINGS("quickSettings"), LOCK("lock");
        private final String wire;
        GlobalAction(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum ServiceCommand implements Value {
        STATUS("status"), APP_LAUNCH("app.launch"), URL_OPEN("url.open"), CLIPBOARD_SET("clipboard.set");
        private final String wire;
        ServiceCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum NotificationCommand implements Value {
        LIST("notifications.list"), DISMISS("notifications.dismiss"), REPLY("notifications.reply"), ACTION("notifications.action");
        private final String wire;
        NotificationCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum DataCommand implements Value {
        DEVICE_INFO("device.info"), APPS_LIST("apps.list"), FILES_LIST("files.list"), FILES_READ("files.read"),
        FILES_WRITE("files.write"), FILES_MKDIR("files.mkdir"), FILES_DELETE("files.delete"), CONTACTS_LIST("contacts.list"),
        CONTACTS_GET("contacts.get"), CONTACTS_INSERT("contacts.insert"), CALENDAR_LIST("calendar.list"), CALENDAR_EVENTS("calendar.events"),
        CALENDAR_INSTANCES("calendar.instances"), CALENDAR_INSERT("calendar.insert"), LOCATION_GET("location.get"), SMS_LIST("sms.list"),
        SMS_SEND("sms.send"), CALLS_LIST("calls.list"), CALL_DIAL("call.dial"), USAGE_QUERY("usage.query"), SETTINGS_GET("settings.get"),
        SETTINGS_PUT("settings.put"), DEVICE_LOCK("device.lock"), DEVICE_REBOOT("device.reboot"), DEVICE_WIPE("device.wipe"),
        APPS_SUSPEND("apps.suspend"), PERMISSIONS_GRANT("permissions.grant");
        private final String wire;
        DataCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum AdminCommand implements Value {
        LOCK("device.lock"), REBOOT("device.reboot"), WIPE("device.wipe"), SUSPEND("apps.suspend"), GRANT("permissions.grant");
        private final String wire;
        AdminCommand(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum NotificationKind implements Value {
        IDLE("idle"), QUESTION("question"), ATTENTION("attention");
        private final String wire;
        NotificationKind(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum CursorType {
        NULL(0), INTEGER(1), FLOAT(2), STRING(3), BLOB(4);
        private final int android;
        CursorType(int android) { this.android = android; }
        static CursorType require(int android) {
            for (CursorType type : values()) if (type.android == android) return type;
            throw new IllegalArgumentException("Invalid cursor field type: " + android);
        }
    }

    enum WritePhase {
        IDLE(false, false, false, false), CONNECTING(true, false, false, false),
        BUFFERING(true, true, false, false), RECORDING(false, true, false, false),
        FINISHING_CONNECTING(true, false, true, false), FINISHING(false, false, true, false),
        CLIPBOARD_READY(false, false, false, true);
        final boolean connecting, recording, finishing, clipboard;
        WritePhase(boolean connecting, boolean recording, boolean finishing, boolean clipboard) {
            this.connecting = connecting; this.recording = recording; this.finishing = finishing; this.clipboard = clipboard;
        }
        boolean busy() { return connecting || recording || finishing; }
        WritePhase connected() {
            return switch (this) {
                case BUFFERING -> RECORDING;
                case FINISHING_CONNECTING -> FINISHING;
                case CONNECTING, IDLE, RECORDING, FINISHING, CLIPBOARD_READY -> throw new IllegalStateException("Unexpected Write connection in " + this);
            };
        }
        WritePhase finish() {
            return switch (this) {
                case BUFFERING -> FINISHING_CONNECTING;
                case RECORDING -> FINISHING;
                case CONNECTING, IDLE, FINISHING_CONNECTING, FINISHING, CLIPBOARD_READY -> throw new IllegalStateException("Cannot finish Write capture in " + this);
            };
        }
    }

    enum Touch {
        DOWN(0), UP(1), MOVE(2), CANCEL(3), OUTSIDE(4), POINTER_DOWN(5), POINTER_UP(6),
        HOVER_MOVE(7), SCROLL(8), HOVER_ENTER(9), HOVER_EXIT(10), BUTTON_PRESS(11), BUTTON_RELEASE(12);
        private final int android;
        Touch(int android) { this.android = android; }
        static Touch require(int android) {
            for (Touch type : values()) if (type.android == android) return type;
            throw new IllegalArgumentException("Invalid motion action: " + android);
        }
    }

    enum PermissionGrant implements Value {
        GRANTED("granted"), DENIED("denied"), DEFAULT("default");
        private final String wire;
        PermissionGrant(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    enum SettingsNamespace implements Value {
        SYSTEM("system"), SECURE("secure"), GLOBAL("global");
        private final String wire;
        SettingsNamespace(String wire) { this.wire = wire; }
        public String wire() { return wire; }
    }

    private NativeState() {}
}

package works.kenan.piremote.kenan;

import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class SetupGate {
    private final MainActivity activity;
    private final View client;
    private final NativeShells.Setup shell;
    private final ActivityResultLauncher<String[]> permissions;
    private final ActivityResultLauncher<android.content.Intent> settings;
    private final Set<NativeState.PhoneSetup> attempted = new HashSet<>();
    private NativeState.PhoneSetup requesting;
    private boolean running;
    private boolean destroyed;
    private boolean entered;

    SetupGate(MainActivity activity, View client) {
        this.activity = activity;
        this.client = client;
        NotificationDelivery.channel(activity);
        permissions = activity.registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> returned());
        settings = activity.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> returned());
        shell = NativeShells.setup(activity, this::start, this::stop);
        ViewGroup root = activity.findViewById(android.R.id.content);
        root.addView(shell.root(), new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(shell.root(), (view, insets) -> {
            var bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        reconcile();
    }
    boolean complete() { return PermissionSetup.complete(activity); }
    void reconcile() {
        if (destroyed) return;
        PermissionSetup.State state = PermissionSetup.state(activity);
        boolean complete = state instanceof PermissionSetup.Complete;
        client.setVisibility(complete ? View.VISIBLE : View.GONE);
        client.setImportantForAccessibility(complete ? View.IMPORTANT_FOR_ACCESSIBILITY_AUTO : View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        shell.root().setVisibility(complete ? View.GONE : View.VISIBLE);
        SharedOverlay.refresh();
        if (complete) {
            running = false;
            PhoneControlService.start(activity);
            if (!entered) activity.setupComplete();
            entered = true;
        } else {
            entered = false;
            var needs = (PermissionSetup.NeedsPermissions) state;
            shell.detail().setText(PermissionSetup.instruction(needs.missing().get(0)));
            shell.grant().setEnabled(requesting == null);
            shell.grant().setText(requesting == null ? "Grant all permissions" : "Waiting for Android…");
            shell.stop().setVisibility(running ? View.VISIBLE : View.GONE);
            NotificationFeedLease.clear();
            ThreadNotifications.pause(activity);
            PhoneControlService.refresh();
        }
    }
    private void start() {
        if (destroyed || requesting != null) return;
        running = true;
        requestNext();
    }
    private void stop() {
        running = false;
        reconcile();
    }
    private void returned() {
        if (destroyed) return;
        NativeState.PhoneSetup previous = requesting;
        requesting = null;
        PhoneControlService.refresh();
        reconcile();
        if (!running || previous == null) return;
        var state = PermissionSetup.state(activity);
        if (state instanceof PermissionSetup.NeedsPermissions needs && needs.missing().contains(previous)) {
            running = false;
            reconcile();
        } else requestNext();
    }
    private void requestNext() {
        if (destroyed || !running || requesting != null) return;
        var state = PermissionSetup.state(activity);
        if (state instanceof PermissionSetup.Complete) { reconcile(); activity.setupComplete(); return; }
        NativeState.PhoneSetup step = ((PermissionSetup.NeedsPermissions) state).missing().get(0);
        requesting = step;
        reconcile();
        List<String> runtime = PermissionSetup.runtime(step);
        boolean asked = attempted.contains(step);
        attempted.add(step);
        boolean deniedPermanently = runtime.stream().anyMatch(permission ->
            activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED
                && asked && !activity.shouldShowRequestPermissionRationale(permission));
        boolean settingsOnly = runtime.isEmpty() || deniedPermanently
            || step == NativeState.PhoneSetup.BACKGROUND_LOCATION && Build.VERSION.SDK_INT >= 30
            || step == NativeState.PhoneSetup.NOTIFICATIONS && runtime.stream().allMatch(permission -> activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED);
        try {
            if (!settingsOnly) { permissions.launch(runtime.toArray(String[]::new)); return; }
            PermissionSetup.SettingsRequest request = PermissionSetup.settings(activity, step);
            if (request instanceof PermissionSetup.OpenSettings open) settings.launch(open.intent());
            else failed(((PermissionSetup.Unsupported) request).message());
        } catch (android.content.ActivityNotFoundException | SecurityException unavailable) {
            failed("Android could not open this permission screen. " + unavailable.getMessage());
        }
    }
    private void failed(String message) {
        requesting = null;
        running = false;
        reconcile();
        shell.detail().setText(message);
    }
    void close() {
        destroyed = true;
        running = false;
        permissions.unregister();
        settings.unregister();
        if (shell.root().getParent() instanceof ViewGroup parent) parent.removeView(shell.root());
    }
}

package works.kenan.piremote.kenan;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.lang.ref.WeakReference;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Deliberately not a BridgeActivity: editor code never receives a native JS interface. */
public final class EditorActivity extends Activity {
    private record Launch(String id, EditorHandoff.Target target, RemoteSession state,
        RemoteSession.Identity identity, long issuedAt) {}
    private static Launch pending;
    private static final Handler handoffs = new Handler(Looper.getMainLooper());
    private static Runnable expirePending;
    private static WeakReference<EditorActivity> visible = new WeakReference<>(null);

    static void launch(Activity owner, EditorHandoff.Target target, RemoteSession state,
        RemoteSession.Identity identity, long issuedAt) {
        EditorActivity previous = visible.get();
        if (previous != null) previous.closeEditor(null);
        String id = UUID.randomUUID().toString();
        if (expirePending != null) handoffs.removeCallbacks(expirePending);
        pending = new Launch(id, target, state, identity, issuedAt);
        expirePending = () -> { if (pending != null && pending.id.equals(id)) pending = null; };
        handoffs.postDelayed(expirePending, Math.max(0, 30_000 - (SystemClock.elapsedRealtime() - issuedAt)));
        try {
            owner.startActivity(new Intent(owner, EditorActivity.class).putExtra("handoff", id));
        } catch (RuntimeException failure) {
            pending = null;
            handoffs.removeCallbacks(expirePending);
            expirePending = null;
            throw failure;
        }
    }

    private final Handler events = new Handler(Looper.getMainLooper());
    private final ExecutorService checks = Executors.newSingleThreadExecutor();
    private final Runnable checkLock = this::checkRemoteSession;
    private WebView editor;
    private volatile Launch launch;
    private Runnable unobserve;
    private boolean receiverRegistered;
    private volatile boolean closed;
    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { closeEditor(null); }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        Launch candidate = pending;
        String handoff = getIntent().getStringExtra("handoff");
        getIntent().removeExtra("handoff");
        if (candidate != null && candidate.id.equals(handoff)) {
            pending = null;
            if (expirePending != null) handoffs.removeCallbacks(expirePending);
            expirePending = null;
        }
        // Restored Activities cannot replay a consumed secret or display restored WebView state.
        if (savedInstanceState != null || candidate == null || !candidate.id.equals(handoff) || !candidate.state.isCurrent(candidate.identity)
            || SystemClock.elapsedRealtime() - candidate.issuedAt >= 30_000 || locked()) {
            closeEditor("Open the editor again from Files");
            return;
        }
        launch = candidate;
        visible = new WeakReference<>(this);
        unobserve = candidate.state.observe(() -> runOnUiThread(() -> {
            if (!candidate.state.isCurrent(candidate.identity)) closeEditor(null);
        }));
        registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED);
        receiverRegistered = true;
        NativeShells.Editor shell = NativeShells.editor(this, () -> closeEditor(null));
        LinearLayout root = shell.root();
        editor = shell.web();
        WebSettings settings = editor.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(editor, false);
        editor.setSaveEnabled(false);
        editor.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        editor.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!current()) { closeEditor(null); return true; }
                Launch snapshot = launch;
                if (snapshot == null || !snapshot.target.permits(request.getUrl().toString())) {
                    if (request.isForMainFrame()) Toast.makeText(EditorActivity.this,
                        "Editor links must stay on your editor origin", Toast.LENGTH_SHORT).show();
                    return true;
                }
                return false;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                Launch snapshot = launch;
                if (!closed && snapshot != null && snapshot.state.isCurrent(snapshot.identity)
                    && (snapshot.target.permits(request.getUrl().toString()) || "blob".equals(scheme) || "data".equals(scheme))) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", java.util.Map.of(),
                    new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                int status = response.getStatusCode();
                if (status == 401 || status == 403 || status == 423) closeEditor("Editor access ended; reopen it from Files");
                else if (request.isForMainFrame() && status >= 400) closeEditor("Editor returned HTTP " + status + "; reopen it from Files");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) closeEditor("Editor connection failed; reopen it from Files");
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                closeEditor("Editor view stopped; reopen it from Files");
                return true;
            }
        });
        setContentView(root);
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                | androidx.core.view.WindowInsetsCompat.Type.displayCutout() | androidx.core.view.WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        if (!current()) { closeEditor(null); return; }
        editor.postUrl(launch.target.url(), launch.target.postBody());
        // Keep only origin/navigation policy after posting, not the consumed ticket.
        launch = new Launch(launch.id, new EditorHandoff.Target(launch.target.url(), launch.target.origin(), ""),
            launch.state, launch.identity, launch.issuedAt);
        events.post(checkLock);
    }

    private boolean locked() { return ((KeyguardManager) getSystemService(KEYGUARD_SERVICE)).isKeyguardLocked(); }
    private boolean current() {
        Launch snapshot = launch;
        return !closed && snapshot != null && snapshot.state.isCurrent(snapshot.identity);
    }

    private void checkRemoteSession() {
        if (!current()) { closeEditor(null); return; }
        Launch captured = launch;
        checks.execute(() -> {
            String failure = null;
            try {
                org.json.JSONObject status = RemoteTransport.get(RouterConnection.routerUrl() + "/v1/lock-status", captured.identity);
                if (!captured.identity.user.equals(status.optString("user")) || !Boolean.TRUE.equals(status.opt("unlocked"))) {
                    failure = "Your folder is locked";
                }
            } catch (RemoteTransport.AccessDenied denied) {
                synchronized (captured.state) {
                    if (captured.state.isCurrent(captured.identity)) NotificationIdentity.replace(this, "", "");
                }
                failure = "Your folder session ended";
            } catch (java.io.IOException unavailable) {
                failure = "Editor session could not be checked; reopen it from Files";
            }
            String message = failure;
            events.post(() -> {
                if (closed) return;
                if (message != null || !current()) closeEditor(message);
                else events.postDelayed(checkLock, 5_000);
            });
        });
    }

    private void closeEditor(String message) {
        if (closed) return;
        closed = true;
        events.removeCallbacksAndMessages(null);
        checks.shutdownNow();
        if (unobserve != null) { unobserve.run(); unobserve = null; }
        if (receiverRegistered) { unregisterReceiver(screenOff); receiverRegistered = false; }
        if (visible.get() == this) visible.clear();
        if (editor != null) {
            WebView owned = editor;
            editor = null;
            owned.setVisibility(android.view.View.GONE);
            owned.stopLoading();
            owned.onPause();
            owned.clearHistory();
            if (owned.getParent() instanceof ViewGroup parent) parent.removeView(owned);
            owned.removeAllViews();
            owned.destroy();
        }
        launch = null;
        if (message != null) Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        finish();
    }

    @Override public void onBackPressed() { closeEditor(null); }
    @Override protected void onResume() {
        super.onResume();
        if (!current() || locked()) closeEditor(null);
    }
    @Override protected void onStop() { closeEditor(null); super.onStop(); }
    @Override protected void onDestroy() { closeEditor(null); super.onDestroy(); }
}

package works.kenan.piremote.kenan;

import android.graphics.Color;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import android.view.View;
import android.view.ViewGroup;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ServerPath;
import com.getcapacitor.WebViewListener;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        NotificationFeedLease.clear();
        ThreadNotifications.pageStarting();
        registerPlugin(KenanRemotePlugin.class);
        // A downloaded web client for this shell replaces the APK's built-in copy.
        WebBundles.Installed bundle = new WebBundles(this).activate();
        if (bundle != null) bridgeBuilder.setServerPath(new ServerPath(ServerPath.PathType.BASE_PATH, bundle.directory.getPath()));
        super.onCreate(savedInstanceState);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(bridge.getWebView(), true);
        bridge.addWebViewListener(new WebViewListener() {
            @Override public void onPageStarted(WebView webView) { NotificationFeedLease.clear(); ThreadNotifications.pageStarting(); IdleNotificationService.requestPoll(); }
        });
        keepSharedClientBelowSystemBars();
        routeSystemBackThroughClient();
    }

    /**
     * The system back gesture does what the client's own back arrow does: close
     * the open sheet, leave the chat for the inbox, return to Chats. The client
     * answers whether it moved; only when it had nowhere to go does the app
     * step aside, staying warm in the recents list rather than being destroyed.
     */
    private void routeSystemBackThroughClient() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge == null) { moveTaskToBack(true); return; }
                bridge.eval("typeof window.PiRemoteBack === 'function' ? window.PiRemoteBack() : false", handled -> {
                    var parsed = NativeState.parse(NativeState.BackResult.class, handled);
                    if (parsed.isEmpty()) {
                        android.widget.Toast.makeText(MainActivity.this, "Client returned an invalid Back result", android.widget.Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Runnable back = switch (parsed.get()) {
                        case HANDLED -> () -> { }; // The web client already performed the navigation.
                        case UNHANDLED -> () -> moveTaskToBack(true);
                    };
                    back.run();
                });
            }
        });
    }

    /** Switches the running WebView to a bundle (or back to the built-in client) and reloads it. */
    void serveWebBundle(WebBundles.Installed bundle) {
        if (bridge == null) return;
        NotificationFeedLease.clear();
        ThreadNotifications.pageStarting();
        if (bundle != null) bridge.setServerBasePath(bundle.directory.getPath());
        else bridge.setServerAssetPath("public");
    }

    @Override
    public void onResume() {
        super.onResume();
        NotificationFeedLease.resume();
        ThreadNotifications.resume(this, this);
        if (bridge != null) bridge.triggerWindowJSEvent("pi-app-foreground");
    }

    @Override
    public void onPause() {
        NotificationFeedLease.pause();
        IdleNotificationService.requestPoll();
        ThreadNotifications.pause(this);
        super.onPause();
    }

    void notificationToast(JSONObject detail) {
        if (bridge != null) bridge.eval("window.dispatchEvent(new CustomEvent('pi-notification-toast', {detail:" + detail + "}))", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge != null) bridge.triggerWindowJSEvent("pi-notification");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) keepSystemBarIconsVisible();
    }

    private void keepSharedClientBelowSystemBars() {
        int background = Color.rgb(11, 13, 16);
        getWindow().getDecorView().setBackgroundColor(background);
        keepSystemBarIconsVisible();
        getWindow().getDecorView().post(this::keepSystemBarIconsVisible);

        View webView = bridge.getWebView();
        ((View) webView.getParent()).setBackgroundColor(background);
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets status = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
            Insets cutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
            int top = Math.max(status.top, cutout.top);
            ViewGroup.MarginLayoutParams layout = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            if (layout.topMargin != top) {
                layout.topMargin = top;
                view.setLayoutParams(layout);
            }
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void keepSystemBarIconsVisible() {
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(
            getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }
}

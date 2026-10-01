package works.kenan.piremote.kenan;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import org.json.JSONObject;

/** An isolated login view: no Capacitor bridge or folder keys are exposed to the Access page. */
final class AccessSignIn {
    static void embeddedCookie(Runnable ready) {
        String token = RouterConnection.token();
        if (token.isEmpty()) { ready.run(); return; }
        try {
            String payload = new String(android.util.Base64.decode(token.split("\\.")[1], android.util.Base64.URL_SAFE), java.nio.charset.StandardCharsets.UTF_8);
            long remaining = new JSONObject(payload).getLong("exp") - System.currentTimeMillis() / 1000;
            // The login's Lax cookie cannot accompany localhost WebSockets and resource navigations.
            // Only this app's cookie jar changes; the edge still validates the original signed JWT.
            CookieManager.getInstance().setCookie(BuildConfig.PUBLIC_ROUTER_URL,
                "CF_Authorization=" + token + "; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=" + Math.max(0, remaining),
                ignored -> { CookieManager.getInstance().flush(); ready.run(); });
        } catch (Exception failure) { RouterConnection.accept(""); ready.run(); }
    }

    static void open(Activity activity, Executor executor, Runnable success, Consumer<String> failure) {
        Dialog dialog = new Dialog(activity);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(activity);
        title.setText("Sign in to Kenan with your invited email, then enter the email code.");
        title.setTextColor(Color.BLACK);
        title.setPadding(24, 24, 24, 16);
        content.addView(title);
        WebView view = new WebView(activity);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);
        content.addView(view, new LinearLayout.LayoutParams(-1, 0, 1));
        Button reload = new Button(activity);
        reload.setText("Reload sign-in");
        reload.setOnClickListener(ignored -> view.reload());
        content.addView(reload);
        Button cancel = new Button(activity);
        cancel.setText("Cancel sign-in");
        content.addView(cancel);
        boolean[] finished = { false };
        boolean[] checking = { false };
        Runnable close = () -> { view.stopLoading(); view.destroy(); dialog.dismiss(); };
        Runnable cancelled = () -> {
            if (finished[0]) return;
            finished[0] = true;
            close.run();
            failure.accept("Sign-in cancelled. Retry to sign in to Kenan.");
        };
        cancel.setOnClickListener(ignored -> cancelled.run());
        dialog.setOnCancelListener(ignored -> cancelled.run());
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, android.webkit.WebResourceRequest request) {
                return !"https".equals(request.getUrl().getScheme());
            }
            @Override public void onPageFinished(WebView webView, String url) {
                if (finished[0] || checking[0] || !RouterConnection.publicUrl(url)) return;
                String cookie = cookies.getCookie(BuildConfig.PUBLIC_ROUTER_URL);
                String token = cookieToken(cookie);
                if (token.isEmpty()) return;
                checking[0] = true;
                executor.execute(() -> {
                    try {
                        int status = RouterConnection.accessStatus(token);
                        activity.runOnUiThread(() -> {
                            checking[0] = false;
                            if (finished[0]) return;
                            if (status != 200) {
                                title.setText("Sign-in was not accepted. Please sign in with an invited email.");
                                return;
                            }
                            RouterConnection.accept(token);
                            embeddedCookie(() -> {
                                if (finished[0]) return;
                                finished[0] = true;
                                close.run();
                                success.run();
                            });
                        });
                    } catch (java.io.IOException error) {
                        activity.runOnUiThread(() -> { checking[0] = false; title.setText("Could not reach Kenan. Check your connection and reload sign-in."); });
                    }
                });
            }
        });
        dialog.setContentView(content);
        dialog.show();
        dialog.getWindow().setLayout(-1, -1);
        cookies.setCookie(BuildConfig.PUBLIC_ROUTER_URL, "CF_Authorization=; Path=/; Secure; HttpOnly; Max-Age=0", ignored ->
            view.loadUrl(BuildConfig.PUBLIC_ROUTER_URL + "/v1/environment"));
    }

    static String cookieToken(String cookies) {
        if (cookies != null) for (String cookie : cookies.split(";")) {
            String entry = cookie.trim();
            if (entry.startsWith("CF_Authorization=")) return entry.substring("CF_Authorization=".length());
        }
        return "";
    }
}

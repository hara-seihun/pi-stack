package works.kenan.piremote.kenan;

import android.app.Activity;
import android.app.Dialog;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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
        NativeShells.SignIn shell = NativeShells.signIn(activity);
        WebView view = shell.web();
        shell.retry().setOnClickListener(ignored -> view.reload());
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);
        boolean[] finished = { false };
        boolean[] checking = { false };
        Runnable close = () -> { view.stopLoading(); view.destroy(); dialog.dismiss(); };
        Runnable cancelled = () -> {
            if (finished[0]) return;
            finished[0] = true;
            close.run();
            failure.accept("Sign-in cancelled. Retry to sign in to Kenan.");
        };
        shell.cancel().setOnClickListener(ignored -> cancelled.run());
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
                                shell.state(NativeShells.SignInState.REJECTED);
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
                        activity.runOnUiThread(() -> { checking[0] = false; shell.state(NativeShells.SignInState.UNAVAILABLE); });
                    }
                });
            }
        });
        dialog.setContentView(shell.root());
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

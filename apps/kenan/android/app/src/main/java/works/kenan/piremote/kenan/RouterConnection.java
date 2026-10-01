package works.kenan.piremote.kenan;

import android.app.Application;
import android.content.SharedPreferences;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;

/** One ingress and Access credential for the bundled client and every background transport. */
public final class RouterConnection extends Application {
    private static SharedPreferences preferences;
    private static boolean selected;

    @Override public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences("router-connection", MODE_PRIVATE);
    }

    static String routerUrl() {
        return preferences == null ? BuildConfig.ROUTER_URL
            : preferences.getString("router", BuildConfig.ROUTER_URL);
    }

    static String token() {
        return preferences == null || !BuildConfig.PUBLIC_ROUTER_URL.equals(preferences.getString("accessRouter", ""))
            ? "" : preferences.getString("access", "");
    }

    static boolean publicUrl(String url) {
        if (BuildConfig.PUBLIC_ROUTER_URL.isEmpty()) return false;
        return sameRouter(url, BuildConfig.PUBLIC_ROUTER_URL);
    }

    static boolean sameRouter(String url, String router) {
        URI target = URI.create(url.replaceFirst("^ws", "http"));
        URI root = URI.create(router);
        String prefix = root.getPath() + "/";
        return root.getScheme().equals(target.getScheme()) && root.getRawAuthority().equals(target.getRawAuthority())
            && (target.getPath().equals(root.getPath()) || target.getPath().startsWith(prefix));
    }

    static synchronized void select() throws IOException {
        if (selected) return;
        String router = BuildConfig.ROUTER_URL;
        if (!BuildConfig.PUBLIC_ROUTER_URL.isEmpty() && !reachable(router)) router = BuildConfig.PUBLIC_ROUTER_URL;
        preferences.edit().putString("router", router).commit();
        selected = true;
    }

    private static boolean reachable(String router) {
        try { return status(router, "", 1_500) == 200; }
        catch (IOException failure) { return false; }
    }

    static int accessStatus(String candidate) throws IOException {
        return status(BuildConfig.PUBLIC_ROUTER_URL, candidate, 7_000);
    }

    private static int status(String router, String credential, int timeout) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(router + "/v1/environment").openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(timeout);
        connection.setReadTimeout(timeout);
        connection.setRequestProperty("accept", "application/json");
        if (!credential.isEmpty()) connection.setRequestProperty("cf-access-token", credential);
        try { return connection.getResponseCode(); }
        finally { connection.disconnect(); }
    }

    static boolean rejected(int status) { return status == 401 || status == 403 || status >= 300 && status < 400; }

    static void accept(String token) {
        preferences.edit().putString("accessRouter", BuildConfig.PUBLIC_ROUTER_URL).putString("access", token).commit();
    }

    static String authorize(HttpURLConnection connection) {
        String credential = publicUrl(connection.getURL().toString()) ? token() : "";
        if (!credential.isEmpty()) connection.setRequestProperty("cf-access-token", credential);
        return credential;
    }

    static okhttp3.Interceptor interceptor() {
        return chain -> {
            okhttp3.Request request = chain.request();
            String credential = publicUrl(request.url().toString()) ? token() : "";
            if (!credential.isEmpty()) request = request.newBuilder().header("cf-access-token", credential).build();
            okhttp3.Response response = chain.proceed(request);
            reject(request.url().toString(), response.code(), credential);
            return response;
        };
    }

    static boolean reject(String url, int status, String credential) {
        if (!publicUrl(url) || !rejected(status)) return false;
        if (token().equals(credential)) accept("");
        return true;
    }
}

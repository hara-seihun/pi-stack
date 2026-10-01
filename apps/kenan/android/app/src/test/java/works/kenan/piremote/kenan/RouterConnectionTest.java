package works.kenan.piremote.kenan;

import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

public class RouterConnectionTest {
    @Test public void ingressScopeIncludesSocketsButNotOtherHostsOrPaths() {
        String root = "https://router.test/pi-stack";
        assertTrue(RouterConnection.sameRouter("https://router.test/pi-stack/v1/environments", root));
        assertTrue(RouterConnection.sameRouter("wss://router.test/pi-stack/v1/write/stream", root));
        for (String url : new String[] { "https://outside.test/pi-stack/v1/files", "https://router.test/other/v1/files",
            "http://router.test/pi-stack/v1/files", "https://person@router.test/pi-stack/v1/files",
            "https://router.test/pi-stack-extra/v1/files" }) assertFalse(RouterConnection.sameRouter(url, root));
    }

    @Test public void cookieParsingDoesNotConfuseAppSessionWithAccessJwt() {
        assertEquals("signed-token", AccessSignIn.cookieToken("CF_AppSession=other; CF_Authorization=signed-token; unrelated=value"));
        assertEquals("", AccessSignIn.cookieToken(null));
    }

    @Test public void credentialIsScopedAndLateRejectionCannotEraseRenewedSignIn() throws Exception {
        assumeFalse(BuildConfig.PUBLIC_ROUTER_URL.isEmpty());
        HashMap<String, String> values = new HashMap<>();
        SharedPreferences.Editor editor = (SharedPreferences.Editor) Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class[] { SharedPreferences.Editor.class }, (object, method, args) -> {
                if (method.getName().equals("putString")) { values.put((String) args[0], (String) args[1]); return object; }
                return method.getName().equals("commit") ? true : null;
            });
        SharedPreferences preferences = (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class[] { SharedPreferences.class }, (object, method, args) -> method.getName().equals("edit")
                ? editor : values.getOrDefault((String) args[0], (String) args[1]));
        var field = RouterConnection.class.getDeclaredField("preferences");
        field.setAccessible(true);
        Object previous = field.get(null);
        field.set(null, preferences);
        try {
            RouterConnection.accept("first-sign-in");
            HttpURLConnection publicRequest = (HttpURLConnection) new URL(BuildConfig.PUBLIC_ROUTER_URL + "/v1/environments").openConnection();
            String credential = RouterConnection.authorize(publicRequest);
            assertEquals("first-sign-in", publicRequest.getRequestProperty("cf-access-token"));
            HttpURLConnection external = (HttpURLConnection) new URL("https://outside.test/v1/files").openConnection();
            RouterConnection.authorize(external);
            assertNull(external.getRequestProperty("cf-access-token"));
            RouterConnection.accept("renewed-sign-in");
            assertTrue(RouterConnection.reject(publicRequest.getURL().toString(), 302, credential));
            assertEquals("renewed-sign-in", RouterConnection.token());
            assertFalse(RouterConnection.reject(publicRequest.getURL().toString(), 423, "renewed-sign-in"));
            assertEquals("renewed-sign-in", RouterConnection.token());
            assertTrue(RouterConnection.reject(publicRequest.getURL().toString(), 403, "renewed-sign-in"));
            assertEquals("", RouterConnection.token());
        } finally { field.set(null, previous); }
    }
}

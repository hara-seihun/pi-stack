package works.kenan.piremote.kenan;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteEnvironmentTest {
    @Test public void discoversOnlyGrantedRouterPaths() throws Exception {
        var endpoints = RemoteEnvironment.parse("https://router.example", new JSONObject("""
            {"environments":[
              {"id":"local","name":"Local","baseUrl":""},
              {"id":"work","name":"Work","baseUrl":"/remotes/work","icon":"work"}
            ]}
            """));
        assertEquals(2, endpoints.size());
        assertEquals("https://router.example", endpoints.get(0).baseUrl);
        assertEquals("https://router.example/remotes/work", endpoints.get(1).baseUrl);
        assertTrue(RemoteEnvironment.parse("https://router.example", new JSONObject("{\"environments\":[]}")).isEmpty());
    }

    @Test public void retainsBootstrapMountForLocalAndRemoteNotificationEndpoints() {
        assertEquals("https://router.example/pi-stack", RemoteEnvironment.resolve("https://router.example/pi-stack", ""));
        assertEquals("https://router.example/pi-stack/v1/remotes/work", RemoteEnvironment.resolve("https://router.example/pi-stack", "/v1/remotes/work"));
    }

    @Test public void rejectsPathsThatCouldSendTheSessionElsewhere() {
        for (String prefix : new String[] { "https://other.example", "//other.example", "remotes/work", "/a/../work", "/../work", "/..", "/%2e%2e/work", "/work?session=x", "/work#fragment", "/work/", "/a//b", "/a\\b" }) {
            assertThrows(prefix, IllegalArgumentException.class, () -> RemoteEnvironment.resolve("https://router.example", prefix));
        }
    }

    @Test public void rejectsDuplicateIdentityInsteadOfSharingNotificationCursors() {
        assertThrows(Exception.class, () -> RemoteEnvironment.parse("https://router.example", new JSONObject("""
            {"environments":[{"id":"local","name":"One","baseUrl":""},{"id":"local","name":"Two","baseUrl":"/two"}]}
            """)));
    }
}

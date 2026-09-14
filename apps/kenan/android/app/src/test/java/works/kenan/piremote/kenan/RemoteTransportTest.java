package works.kenan.piremote.kenan;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.Rule;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteTransportTest {
    @Rule public final MockWebServer server = new MockWebServer();

    @Test public void authenticatesDiscoveryAndProxiedPollsWithoutUrlCredentials() throws Exception {
        var identity = new RemoteSession.Identity("person", "test-session");
        for (String path : new String[] { "/v1/environments", "/remotes/work/v1/notifications?after=2" }) {
            server.enqueue(new MockResponse().setBody("{\"ok\":true}"));
            assertTrue(RemoteTransport.get(server.url(path).toString(), identity).getBoolean("ok"));
            RecordedRequest request = server.takeRequest(1, TimeUnit.SECONDS);
            assertNotNull(request);
            assertEquals("GET", request.getMethod());
            assertEquals(path, request.getPath());
            assertEquals("person", request.getHeader("x-pi-remote-user"));
            assertEquals("test-session", request.getHeader("x-pi-remote-session"));
        }
    }

    @Test public void missingSessionNeverConnects() throws Exception {
        server.enqueue(new MockResponse().setBody("{\"ok\":true}"));
        assertThrows(RemoteTransport.AccessDenied.class,
            () -> RemoteTransport.get(server.url("/v1/environments").toString(), null));
        assertEquals(0, server.getRequestCount());
    }

    @Test public void redirectsNeverForwardSession() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "/destination"));
        server.enqueue(new MockResponse().setBody("{\"ok\":true}"));
        assertThrows(IOException.class, () -> RemoteTransport.get(
            server.url("/v1/environments").toString(), new RemoteSession.Identity("person", "token")));
        assertEquals(1, server.getRequestCount());
    }

    @Test public void deniedSessionHasAnExplicitOutcome() throws Exception {
        for (int status : new int[] { 401, 403, 423 }) {
            server.enqueue(new MockResponse().setResponseCode(status));
            assertThrows(RemoteTransport.AccessDenied.class, () -> RemoteTransport.get(
                server.url("/").toString(), new RemoteSession.Identity("person", "token")));
        }
    }
}

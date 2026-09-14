package works.kenan.piremote.kenan;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteTransportTest {
    @Test public void authenticatesDiscoveryAndProxiedPollsWithoutUrlCredentials() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> headers = new AtomicReference<>();
        server.createContext("/", exchange -> {
            headers.set(exchange.getRequestHeaders().getFirst("x-pi-remote-user") + ":"
                + exchange.getRequestHeaders().getFirst("x-pi-remote-session") + ":" + exchange.getRequestURI());
            byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        server.start();
        try {
            var identity = new RemoteSession.Identity("person", "test-session");
            for (String path : new String[] { "/v1/environments", "/remotes/work/v1/notifications?after=2" }) {
                assertTrue(RemoteTransport.get("http://127.0.0.1:" + server.getAddress().getPort() + path, identity).getBoolean("ok"));
                assertEquals("person:test-session:" + path, headers.get());
            }
        } finally { server.stop(0); }
    }

    @Test public void missingSessionNeverConnectsAndRedirectsNeverForwardIt() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/", exchange -> {
            requests.incrementAndGet();
            exchange.getResponseHeaders().set("Location", "/destination");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.start();
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/environments";
            assertThrows(RemoteTransport.AccessDenied.class, () -> RemoteTransport.get(url, null));
            assertEquals(0, requests.get());
            assertThrows(java.io.IOException.class, () -> RemoteTransport.get(url, new RemoteSession.Identity("person", "token")));
            assertEquals(1, requests.get());
        } finally { server.stop(0); }
    }

    @Test public void deniedSessionHasAnExplicitOutcome() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(403, -1);
            exchange.close();
        });
        server.start();
        try {
            assertThrows(RemoteTransport.AccessDenied.class, () -> RemoteTransport.get(
                "http://127.0.0.1:" + server.getAddress().getPort(), new RemoteSession.Identity("person", "token")));
        } finally { server.stop(0); }
    }
}

package works.kenan.piremote.kenan;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class RemoteTransportTest {
    @Test
    public void acceptsTheConfiguredEnvironment() throws Exception {
        RemoteTransport.verifyHealth("local", 200, "{\"ok\":true,\"environmentId\":\"local\"}");
    }

    @Test
    public void sendsThePersonWhenVerifyingAnEndpoint() throws Exception {
        CompletableFuture<String> identity = new CompletableFuture<>();
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Thread responder = new Thread(() -> respondToHealthCheck(server, identity));
            responder.start();

            RemoteEnvironment.Endpoint endpoint = RemoteEnvironment.Endpoint.direct(
                "local", "Local", "http://127.0.0.1:" + server.getLocalPort(), true);
            new RemoteTransport().verify(endpoint, "kenan");

            assertEquals("kenan", identity.get(1, TimeUnit.SECONDS));
            responder.join(1_000);
        }
    }

    private static void respondToHealthCheck(ServerSocket server, CompletableFuture<String> identity) {
        try (Socket socket = server.accept();
             BufferedReader request = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII))) {
            String user = "";
            for (String line = request.readLine(); line != null && !line.isEmpty(); line = request.readLine()) {
                if (line.toLowerCase().startsWith("x-pi-remote-user:")) user = line.substring(line.indexOf(':') + 1).trim();
            }
            identity.complete(user);
            byte[] body = "{\"ok\":true,\"environmentId\":\"local\"}".getBytes(StandardCharsets.UTF_8);
            socket.getOutputStream().write((
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length +
                "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(body);
            socket.getOutputStream().flush();
        } catch (Exception failure) {
            identity.completeExceptionally(failure);
        }
    }

    @Test
    public void rejectsAnotherEnvironment() {
        assertThrows(IOException.class, () ->
            RemoteTransport.verifyHealth("local", 200, "{\"ok\":true,\"environmentId\":\"converge\"}"));
    }

    @Test
    public void rejectsFailedAndInvalidHealthResponses() {
        assertThrows(IOException.class, () -> RemoteTransport.verifyHealth("local", 503, "{}"));
        assertThrows(IOException.class, () -> RemoteTransport.verifyHealth("local", 200, "not json"));
    }
}

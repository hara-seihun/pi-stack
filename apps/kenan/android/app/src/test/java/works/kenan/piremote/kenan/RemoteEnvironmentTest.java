package works.kenan.piremote.kenan;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class RemoteEnvironmentTest {
    @Test
    public void directEndpointNormalizesItsBaseUrl() {
        RemoteEnvironment.Endpoint endpoint = RemoteEnvironment.Endpoint.direct(
            "test", "Test", "https://example.test///", false);

        assertEquals("https://example.test", endpoint.baseUrl);
        assertEquals(RemoteEnvironment.Authentication.DIRECT, endpoint.authentication);
    }

    @Test
    public void sshEndpointUsesItsPinnedLoopbackPort() {
        RemoteEnvironment.Ssh ssh = new RemoteEnvironment.Ssh(
            "example.test", 22, "agent", "a2V5", "ssh-ed25519 a2V5", 9876, "127.0.0.1", 8788);
        RemoteEnvironment.Endpoint endpoint = RemoteEnvironment.Endpoint.ssh("ssh", "SSH", false, ssh);

        assertEquals("http://127.0.0.1:9876", endpoint.baseUrl);
        assertEquals(RemoteEnvironment.Authentication.SSH, endpoint.authentication);
    }

    @Test
    public void rejectsInvalidSshPorts() {
        assertThrows(IllegalArgumentException.class, () -> new RemoteEnvironment.Ssh(
            "example.test", 0, "agent", "a2V5", "ssh-ed25519 a2V5", 9876, "127.0.0.1", 8788));
    }

    @Test
    public void parsesADeclaredEndpointList() {
        java.util.List<RemoteEnvironment.Endpoint> endpoints = RemoteEnvironment.parse(
            "[{\"id\":\"home\",\"name\":\"Home\",\"auth\":\"direct\",\"url\":\"https://home.test/\",\"requiresUnlock\":true},"
            + "{\"id\":\"work\",\"auth\":\"ssh\",\"ssh\":{\"host\":\"work.test\",\"user\":\"agent\",\"privateKeyBase64\":\"a2V5\","
            + "\"hostKey\":\"ssh-ed25519 a2V5\",\"localPort\":8789}}]");

        assertEquals(2, endpoints.size());
        assertEquals("https://home.test", endpoints.get(0).baseUrl);
        assertEquals(true, endpoints.get(0).requiresUnlock);
        assertEquals("work", endpoints.get(1).name);
        assertEquals("http://127.0.0.1:8789", endpoints.get(1).baseUrl);
        assertEquals(22, endpoints.get(1).ssh.port);
        assertEquals(8788, endpoints.get(1).ssh.remotePort);
    }

    @Test
    public void rejectsRepeatedEndpointIds() {
        assertThrows(IllegalArgumentException.class, () -> RemoteEnvironment.parse(
            "[{\"id\":\"a\",\"url\":\"http://a.test\"},{\"id\":\"a\",\"url\":\"http://b.test\"}]"));
    }
}

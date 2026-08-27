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
}

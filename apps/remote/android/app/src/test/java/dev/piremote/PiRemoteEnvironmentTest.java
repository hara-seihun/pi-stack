package dev.piremote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class PiRemoteEnvironmentTest {
    @Test public void parsesSupportedAuthenticationSchemes() {
        assertEquals(PiRemoteEnvironment.Authentication.DIRECT,
            PiRemoteEnvironment.Authentication.parse("direct"));
        assertEquals(PiRemoteEnvironment.Authentication.SSH,
            PiRemoteEnvironment.Authentication.parse("SSH"));
        assertThrows(IllegalArgumentException.class,
            () -> PiRemoteEnvironment.Authentication.parse("token"));
    }

    @Test public void sshEndpointUsesOnlyItsLoopbackForward() {
        PiRemoteEnvironment.Ssh ssh = new PiRemoteEnvironment.Ssh(
            "example.test", 22, "pi-remote", "cHJpdmF0ZQ==",
            "ecdsa-sha2-nistp256 aG9zdA==", 18789, "127.0.0.1", 8788);
        PiRemoteEnvironment.Endpoint endpoint = PiRemoteEnvironment.Endpoint.ssh(
            "converge", "Converge", false, ssh);

        assertEquals(PiRemoteEnvironment.Authentication.SSH, endpoint.authentication);
        assertEquals("http://127.0.0.1:18789", endpoint.baseUrl);
        assertEquals("127.0.0.1", endpoint.ssh.remoteHost);
        assertEquals(8788, endpoint.ssh.remotePort);
    }
}

package works.kenan.piremote.kenan;

import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertThrows;

public class RemoteTransportTest {
    @Test
    public void acceptsTheConfiguredEnvironment() throws Exception {
        RemoteTransport.verifyHealth("local", 200, "{\"ok\":true,\"environmentId\":\"local\"}");
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

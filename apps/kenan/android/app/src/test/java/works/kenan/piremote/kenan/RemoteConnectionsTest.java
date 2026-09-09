package works.kenan.piremote.kenan;

import org.junit.Test;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertNotSame;

public class RemoteConnectionsTest {
    @Test public void uiAndNotificationsShareOnlyTheAddressedEnvironmentsTransport() {
        RemoteEnvironment.Endpoint local = RemoteEnvironment.Endpoint.direct("test-local", "Local", "http://localhost:8788", false);
        RemoteEnvironment.Endpoint work = RemoteEnvironment.Endpoint.direct("test-work", "Work", "http://localhost:8789", false);
        RemoteEnvironment.Endpoint another = RemoteEnvironment.Endpoint.direct("test-another", "Another", "http://localhost:8790", false);
        RemoteTransport watched = RemoteConnections.forEndpoint(work);
        assertSame(watched, RemoteConnections.forEndpoint(work));
        assertNotSame(watched, RemoteConnections.forEndpoint(local));
        assertNotSame(watched, RemoteConnections.forEndpoint(another));
        RemoteConnections.forEndpoint(local).close();
        assertSame(watched, RemoteConnections.forEndpoint(work));
    }
}

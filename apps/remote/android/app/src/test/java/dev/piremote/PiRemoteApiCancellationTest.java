package dev.piremote;

import static org.junit.Assert.*;

import java.net.HttpURLConnection;
import java.net.URL;
import org.junit.Test;

public class PiRemoteApiCancellationTest {
    private static final class Connection extends HttpURLConnection {
        boolean disconnected;

        Connection() throws Exception { super(new URL("http://127.0.0.1/")); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
    }

    @Test public void cancellationDisconnectsTheActiveRequest() throws Exception {
        PiRemoteApi.Cancellation cancellation = new PiRemoteApi.Cancellation();
        Connection connection = new Connection();
        assertTrue(cancellation.attach(connection));

        cancellation.cancel();

        assertTrue(connection.disconnected);
        assertTrue(cancellation.isCancelled());
    }

    @Test public void cancelledPollCannotAttachAReplacementConnection() throws Exception {
        PiRemoteApi.Cancellation cancellation = new PiRemoteApi.Cancellation();
        cancellation.cancel();

        assertFalse(cancellation.attach(new Connection()));
    }

    @Test public void completedRequestIsNotDisconnectedLater() throws Exception {
        PiRemoteApi.Cancellation cancellation = new PiRemoteApi.Cancellation();
        Connection connection = new Connection();
        assertTrue(cancellation.attach(connection));
        cancellation.detach(connection);

        cancellation.cancel();

        assertFalse(connection.disconnected);
    }
}

package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.junit.Test;

public final class WriteConnectionTest {
    private static void await(CountDownLatch latch) throws InterruptedException {
        assertTrue("Connection did not settle", latch.await(2, TimeUnit.SECONDS));
    }
    private static final class Socket implements WebSocket {
        Request request;
        WebSocketListener listener;
        int cancellations;
        boolean accepts = true;
        final List<String> messages = new ArrayList<>();
        public Request request() { return request; }
        public long queueSize() { return 0; }
        public boolean send(String message) { messages.add(message); return accepts; }
        public boolean send(ByteString bytes) { messages.add("audio:" + bytes.hex()); return accepts; }
        public boolean close(int code, String reason) { return true; }
        public void cancel() {
            cancellations++;
            // Also exercise reentrant transport failure while terminalizing.
            listener.onFailure(this, new IOException("Cancelled"), null);
        }
    }
    private static final class Capture implements WriteConnection.Events {
        final Socket socket = new Socket();
        final CountDownLatch opened = new CountDownLatch(1), done = new CountDownLatch(1);
        final AtomicBoolean current = new AtomicBoolean(true);
        final AtomicInteger allocations = new AtomicInteger();
        int connected, terminals, partials;
        String result, failure;
        final List<String> notices = new ArrayList<>();
        boolean cleanedAtCallback;
        WriteConnection connection(WriteConnection.EndpointLookup lookup) {
            return new WriteConnection(new RemoteSession.Identity("person", "token"), this, lookup, current::get,
                (request, listener) -> {
                    socket.request = request;
                    socket.listener = listener;
                    allocations.incrementAndGet();
                    opened.countDown();
                    return socket;
                });
        }
        WriteConnection connect() throws Exception {
            WriteConnection connection = connection(() -> "http://localhost");
            connection.connect("Previous text");
            await(opened);
            // Wait for the connection to publish its socket before invoking callbacks.
            connection.queueSize();
            socket.listener.onOpen(socket, null);
            return connection;
        }
        public void connected() { connected++; }
        public void partial(String text) { partials++; }
        public void notice(String message) { notices.add(message); }
        public void finished(String text) { result = text; terminal(); }
        public void failed(String message) { failure = message; terminal(); }
        private void terminal() { terminals++; cleanedAtCallback = socket.cancellations > 0 || allocations.get() == 0; done.countDown(); }
        void closed() throws Exception { await(done); assertEquals(1, terminals); assertTrue(cleanedAtCallback); }
    }

    @Test public void finalReleasesTransportBeforeCallbackAndIgnoresLateEvents() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connect();
        assertEquals(1, capture.connected);
        assertEquals("person", capture.socket.request.header("x-pi-remote-user"));
        capture.socket.listener.onMessage(capture.socket, "{\"type\":\"final\",\"text\":\"Done\"}");
        capture.closed();
        assertEquals("Done", capture.result);
        assertTrue(connection.ended());
        assertFalse(connection.audio(new byte[] { 1 }));
        connection.finish();
        capture.socket.listener.onMessage(capture.socket, "{\"type\":\"partial\",\"tail\":\"Late\"}");
        capture.socket.listener.onMessage(capture.socket, "{\"type\":\"final\",\"text\":\"Late\"}");
        capture.socket.listener.onClosed(capture.socket, 1000, "Done");
        assertEquals(1, capture.terminals);
        assertEquals(0, capture.partials);
        assertEquals(1, capture.socket.messages.size());
    }

    @Test public void guardedOrUnavailableRewriteStillInsertsTextWithOneVisibleNotice() throws Exception {
        for (String status : List.of("guarded", "unavailable")) {
            Capture capture = new Capture();
            capture.connect();
            String response = "{\"type\":\"final\",\"text\":\"Keep this transcript\",\"rewrite\":{\"status\":\"" + status + "\",\"reason\":\"inference_failed\"}}";
            capture.socket.listener.onMessage(capture.socket, response);
            capture.closed();
            assertEquals("Keep this transcript", capture.result);
            assertEquals(1, capture.notices.size());
            capture.socket.listener.onMessage(capture.socket, response);
            assertEquals(1, capture.notices.size());
        }
    }

    @Test public void coldRewriteWarmingKeepsTranscriptAndReportsItsActualState() throws Exception {
        Capture capture = new Capture();
        capture.connect();
        capture.socket.listener.onMessage(capture.socket,
            "{\"type\":\"final\",\"text\":\"Ready transcript\",\"rewrite\":{\"status\":\"unavailable\",\"reason\":\"warming\"}}");
        capture.closed();
        assertEquals("Ready transcript", capture.result);
        assertEquals(List.of("Local rewrite is warming up; inserted the transcript."), capture.notices);
    }

    @Test public void finishFollowsTailPacketExactlyOnceAndKeepsSocketForFinal() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connect();
        assertTrue(connection.audio(new byte[] { 1 }));
        assertTrue(connection.audio(new byte[] { 2 }));
        connection.finish(); connection.finish();
        assertFalse(connection.audio(new byte[] { 3 }));
        assertEquals(4, capture.socket.messages.size());
        assertEquals(List.of("audio:01", "audio:02", "{\"type\":\"finish\"}"), capture.socket.messages.subList(1, 4));
        assertEquals(0, capture.socket.cancellations);
        capture.socket.listener.onMessage(capture.socket, "{\"type\":\"final\",\"text\":\"Last word\"}");
        capture.closed();
        assertEquals("Last word", capture.result);
    }

    @Test public void serverErrorAndMalformedResponseAreTerminalAndReleaseSocket() throws Exception {
        for (String response : new String[] { "{\"type\":\"error\",\"message\":\"Recognition failed\"}", "not json", "{\"type\":\"final\"}" }) {
            Capture capture = new Capture();
            WriteConnection connection = capture.connect();
            capture.socket.listener.onMessage(capture.socket, response);
            capture.closed();
            assertNotNull(capture.failure);
            assertTrue(connection.ended());
            assertFalse(connection.audio(new byte[] { 1 }));
            capture.socket.listener.onClosed(capture.socket, 1000, "Gone");
            assertEquals(1, capture.terminals);
        }
    }

    @Test public void undescribedWireStatesFailBeforeInsertingTextAndReleaseTransport() throws Exception {
        for (String response : List.of(
            "{\"type\":\"future-event\"}",
            "{\"type\":\"final\",\"text\":\"Do not insert\",\"rewrite\":{\"status\":\"future-status\"}}",
            "{\"type\":\"final\",\"text\":\"Do not insert\",\"rewrite\":{\"status\":\"unavailable\",\"reason\":\"future-reason\"}}",
            "{\"type\":\"final\",\"text\":\"Do not insert\",\"rewrite\":{\"status\":\"unavailable\"}}",
            "{\"type\":\"final\",\"text\":\"Do not insert\",\"rewrite\":\"applied\"}")) {
            Capture capture = new Capture();
            WriteConnection connection = capture.connect();
            capture.socket.listener.onMessage(capture.socket, response);
            capture.closed();
            assertTrue(capture.failure.startsWith("Invalid dictation response"));
            assertNull(capture.result);
            assertTrue(capture.notices.isEmpty());
            assertTrue(connection.ended());
            assertFalse(connection.audio(new byte[] { 1 }));
        }
    }

    @Test public void successfulRewriteStatusesFinishWithoutADegradedNotice() throws Exception {
        for (String status : List.of("applied", "unchanged")) {
            Capture capture = new Capture();
            capture.connect();
            capture.socket.listener.onMessage(capture.socket,
                "{\"type\":\"final\",\"text\":\"Done\",\"rewrite\":{\"status\":\"" + status + "\"}}");
            capture.closed();
            assertEquals("Done", capture.result);
            assertNull(capture.failure);
            assertTrue(capture.notices.isEmpty());
        }
    }

    @Test public void rejectedStartAndFinishCannotLeaveLiveSocket() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connection(() -> "http://localhost");
        connection.connect(""); await(capture.opened); connection.queueSize();
        capture.socket.accepts = false;
        capture.socket.listener.onOpen(capture.socket, null);
        capture.closed();
        assertEquals("Could not start dictation", capture.failure);
        assertEquals(0, capture.connected);

        capture = new Capture();
        connection = capture.connect();
        capture.socket.accepts = false;
        connection.finish();
        capture.closed();
        assertEquals("Could not finish dictation", capture.failure);
    }

    @Test public void peerClosingBeforeFinalIsTerminalWithoutWaitingForCloseHandshake() throws Exception {
        Capture capture = new Capture();
        capture.connect();
        capture.socket.listener.onClosing(capture.socket, 1000, "Disconnected");
        capture.closed();
        assertTrue(capture.failure.contains("before final text"));
    }

    @Test public void cancellationImmediatelyReleasesSocketAndSuppressesEvents() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connect();
        connection.cancel(); connection.cancel();
        assertFalse(connection.ended());
        assertEquals(1, capture.socket.cancellations);
        capture.socket.listener.onClosed(capture.socket, 1000, "Cancelled");
        assertEquals(0, capture.terminals);
        assertFalse(connection.audio(new byte[] { 1 }));
    }

    @Test public void expiredIdentityCannotContinueSendingAudio() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connect();
        capture.current.set(false);
        assertFalse(connection.audio(new byte[] { 1 }));
        assertFalse(connection.ended());
        assertEquals(1, capture.socket.cancellations);
        assertEquals(0, capture.terminals);
    }

    @Test public void cancellationDuringDiscoveryDoesNotAllocateSocketOrConnectTwice() throws Exception {
        CountDownLatch discovering = new CountDownLatch(1), resume = new CountDownLatch(1), discovered = new CountDownLatch(1);
        Capture capture = new Capture();
        AtomicInteger lookups = new AtomicInteger();
        WriteConnection connection = capture.connection(() -> {
            lookups.incrementAndGet(); discovering.countDown();
            try { if (!resume.await(2, TimeUnit.SECONDS)) throw new IOException("Discovery timed out"); }
            catch (InterruptedException error) { throw new IOException(error); }
            discovered.countDown();
            return "http://localhost";
        });
        connection.connect(""); connection.connect(""); await(discovering);
        connection.cancel(); resume.countDown(); await(discovered);
        connection.connect("");
        assertEquals(1, lookups.get());
        assertEquals(0, capture.allocations.get());
        assertEquals(0, capture.terminals);
    }

    @Test public void invalidEndpointIsReportedInsteadOfEscapingConnectionThread() throws Exception {
        Capture capture = new Capture();
        WriteConnection connection = capture.connection(() -> "invalid-url");
        connection.connect("");
        capture.closed();
        assertTrue(capture.failure.startsWith("Write server unreachable"));
        assertEquals(0, capture.allocations.get());
    }
}

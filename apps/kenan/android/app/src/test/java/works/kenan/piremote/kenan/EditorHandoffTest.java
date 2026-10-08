package works.kenan.piremote.kenan;

import org.junit.Test;
import static org.junit.Assert.*;

public class EditorHandoffTest {
    private static final String ORIGIN = "http://editor-one.mesh.test:8812";
    private static final String TICKET = "a".repeat(43);

    private EditorHandoff.Validation check(String url, String ticket, String origin) {
        return EditorHandoff.validate(url, ticket, origin, "http://app.mesh.test/pi-stack", "http://localhost");
    }

    @Test public void ticketOnlyAppearsInPostBodyAndNavigationStaysOnOrigin() {
        var accepted = (EditorHandoff.Accepted) check(ORIGIN + "/editor/open", TICKET, ORIGIN);
        var target = accepted.target();
        assertEquals("ticket=" + TICKET, new String(target.postBody(), java.nio.charset.StandardCharsets.US_ASCII));
        assertFalse(target.url().contains(TICKET));
        assertTrue(target.permits(ORIGIN + "/?folder=%2Fhome%2Fone"));
        assertFalse(target.permits("http://editor-two.mesh.test:8812/"));
        assertFalse(target.permits("http://editor-one.mesh.test:8813/"));
        assertFalse(target.permits("https://editor-one.mesh.test:8812/"));
        assertFalse(target.permits("http://user@editor-one.mesh.test:8812/"));
        assertFalse(target.permits("javascript:alert(1)"));
        assertFalse(target.permits("file:///data/user/0/app/shared_prefs/session.xml"));
    }

    @Test public void rejectsUrlSecretsPathConfusionAndMalformedOrigins() {
        for (String url : new String[] { ORIGIN + "/editor/open?ticket=" + TICKET, ORIGIN + "/editor/open#fragment",
            ORIGIN + "/editor/%6fpen", ORIGIN + "/v1/unlock", ORIGIN + "/editor/../editor/open",
            "http://user:password@editor-one.mesh.test:8812/editor/open", "file:///editor/open",
            "http://editor-one.mesh.test:0/editor/open", "http://editor-one.mesh.test:65536/editor/open" }) {
            assertTrue(url, check(url, TICKET, ORIGIN) instanceof EditorHandoff.Rejected);
        }
        assertTrue(check(ORIGIN + "/editor/open", TICKET, ORIGIN + "/") instanceof EditorHandoff.Rejected);
        assertTrue(check(ORIGIN + "/editor/open", TICKET, "http://editor-two.mesh.test:8812") instanceof EditorHandoff.Rejected);
        assertTrue(check("http://app.mesh.test/editor/open", TICKET, "http://app.mesh.test") instanceof EditorHandoff.Rejected);
        assertTrue(check("http://localhost/editor/open", TICKET, "http://localhost") instanceof EditorHandoff.Rejected);
    }

    @Test public void ticketCannotInjectAdditionalFormFields() {
        for (String ticket : new String[] { "", "a".repeat(42), "a".repeat(44), TICKET + "&other=secret", "a".repeat(42) + "+", "a".repeat(42) + "\n" }) {
            assertTrue(check(ORIGIN + "/editor/open", ticket, ORIGIN) instanceof EditorHandoff.Rejected);
        }
    }
}

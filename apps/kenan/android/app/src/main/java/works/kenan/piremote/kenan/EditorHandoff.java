package works.kenan.piremote.kenan;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;

final class EditorHandoff {
    enum Failure { INVALID_URL, INVALID_TICKET, INVALID_ORIGIN, APP_ORIGIN }
    sealed interface Validation permits Accepted, Rejected {}
    record Accepted(Target target) implements Validation {}
    record Rejected(Failure failure) implements Validation {}
    record Target(String url, String origin, String ticket) {
        byte[] postBody() { return ("ticket=" + ticket).getBytes(StandardCharsets.US_ASCII); }
        boolean permits(String candidate) {
            URI uri = parse(candidate);
            return validHttp(uri) && origin.equals(EditorHandoff.origin(uri));
        }
    }

    static Validation validate(String url, String ticket, String configuredOrigin, String... appUrls) {
        if (ticket == null || !ticket.matches("[A-Za-z0-9_-]{43}")) return new Rejected(Failure.INVALID_TICKET);
        URI target = parse(url);
        if (!validHttp(target) || !"/editor/open".equals(target.getRawPath())
            || target.getRawQuery() != null || target.getRawFragment() != null) return new Rejected(Failure.INVALID_URL);
        URI configured = parse(configuredOrigin);
        if (!validHttp(configured) || !origin(configured).equals(configuredOrigin)) return new Rejected(Failure.INVALID_ORIGIN);
        if (!origin(target).equals(configuredOrigin)) return new Rejected(Failure.INVALID_ORIGIN);
        for (String appUrl : appUrls) {
            URI app = parse(appUrl);
            if (validHttp(app) && origin(target).equals(origin(app))) return new Rejected(Failure.APP_ORIGIN);
        }
        return new Accepted(new Target(target.toASCIIString(), configuredOrigin, ticket));
    }

    private static URI parse(String value) {
        if (value == null) return null;
        try { return new URI(value); }
        catch (URISyntaxException invalid) { return null; }
    }

    private static boolean validHttp(URI uri) {
        return uri != null && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
            && uri.getHost() != null && !uri.getHost().isBlank() && uri.getRawUserInfo() == null
            && (uri.getPort() == -1 || uri.getPort() > 0 && uri.getPort() <= 65535)
            && uri.toASCIIString().equals(uri.toString());
    }

    private static String origin(URI uri) {
        int port = uri.getPort();
        boolean conventional = port == -1 || port == 80 && "http".equals(uri.getScheme()) || port == 443 && "https".equals(uri.getScheme());
        return uri.getScheme() + "://" + uri.getHost().toLowerCase(java.util.Locale.ROOT) + (conventional ? "" : ":" + port);
    }

    private EditorHandoff() {}
}

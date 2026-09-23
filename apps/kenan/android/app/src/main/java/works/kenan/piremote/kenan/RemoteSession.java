package works.kenan.piremote.kenan;

final class RemoteSession {
    static final class Identity {
        final String user;
        final String session;

        Identity(String user, String session) {
            this.user = user;
            this.session = session;
        }
    }

    private Identity current;

    synchronized Identity current() { return current; }

    synchronized boolean replace(String user, String session) {
        if (user == null || session == null || user.isBlank() != session.isBlank()
            || user.contains("\r") || user.contains("\n") || session.contains("\r") || session.contains("\n")) {
            throw new IllegalArgumentException("Provide both user and session, or empty strings to clear them");
        }
        if (current == null && session.isBlank()) return false;
        if (current != null && current.user.equals(user) && current.session.equals(session)) return false;
        current = session.isBlank() ? null : new Identity(user, session);
        return true;
    }

    synchronized boolean isCurrent(Identity identity) { return identity != null && current == identity; }
}

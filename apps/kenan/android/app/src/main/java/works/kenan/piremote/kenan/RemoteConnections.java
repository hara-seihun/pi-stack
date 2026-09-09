package works.kenan.piremote.kenan;

import java.util.concurrent.ConcurrentHashMap;

final class RemoteConnections {
    private static final ConcurrentHashMap<String, RemoteTransport> transports = new ConcurrentHashMap<>();

    static RemoteTransport forEndpoint(RemoteEnvironment.Endpoint endpoint) {
        return transports.computeIfAbsent(endpoint.id, id -> new RemoteTransport());
    }
}

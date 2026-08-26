package dev.piremote;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

final class PiRemoteTransport {
    private static final int CONNECT_TIMEOUT_MS = 7_000;
    private static final String HOST_KEY_ALIAS = "pi-remote-converge";
    private static Session sshSession;
    private static PiRemoteEnvironment.Ssh activeConfig;

    private PiRemoteTransport() {}

    static void ensure(PiRemoteEnvironment.Endpoint endpoint) throws IOException {
        if (endpoint.authentication == PiRemoteEnvironment.Authentication.DIRECT) return;
        ensureSsh(endpoint.ssh);
    }

    static synchronized void invalidate(PiRemoteEnvironment.Endpoint endpoint) {
        if (endpoint.authentication != PiRemoteEnvironment.Authentication.SSH) return;
        disconnect();
    }

    private static synchronized void ensureSsh(PiRemoteEnvironment.Ssh config) throws IOException {
        if (sshSession != null && sshSession.isConnected() && activeConfig == config) return;
        disconnect();

        Session candidate = null;
        try {
            String[] hostKey = config.hostKey.trim().split("\\s+");
            if (hostKey.length != 2) throw new IOException("SSH host key must contain an algorithm and key");
            byte[] privateKey;
            try {
                privateKey = Base64.getDecoder().decode(config.privateKeyBase64);
            } catch (IllegalArgumentException invalid) {
                throw new IOException("SSH private key is not valid base64", invalid);
            }

            JSch jsch = new JSch();
            String knownHost = HOST_KEY_ALIAS + " " + hostKey[0] + " " + hostKey[1] + "\n";
            jsch.setKnownHosts(new ByteArrayInputStream(knownHost.getBytes(StandardCharsets.US_ASCII)));
            jsch.addIdentity("pi-remote-android", privateKey, null, null);

            candidate = jsch.getSession(config.user, config.host, config.port);
            candidate.setHostKeyAlias(HOST_KEY_ALIAS);
            candidate.setConfig("StrictHostKeyChecking", "yes");
            candidate.setConfig("PreferredAuthentications", "publickey");
            candidate.setServerAliveInterval(15_000);
            candidate.setServerAliveCountMax(3);
            candidate.connect(CONNECT_TIMEOUT_MS);
            int forwarded = candidate.setPortForwardingL(
                "127.0.0.1", config.localPort, config.remoteHost, config.remotePort);
            if (forwarded != config.localPort)
                throw new IOException("SSH assigned an unexpected local forwarding port");

            sshSession = candidate;
            activeConfig = config;
        } catch (JSchException failure) {
            if (candidate != null) candidate.disconnect();
            throw new IOException("Could not establish the Pi Remote SSH connection", failure);
        } catch (IOException failure) {
            if (candidate != null) candidate.disconnect();
            throw failure;
        }
    }

    private static void disconnect() {
        if (sshSession != null) sshSession.disconnect();
        sshSession = null;
        activeConfig = null;
    }
}

package dev.piremote;

import android.content.Context;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

final class PiRemoteCache {
    private PiRemoteCache() {}

    static void save(Context context, String environmentId, String sessionId, ContextSync.Document document) throws Exception {
        File target = path(context, environmentId, sessionId);
        File parent = target.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new java.io.IOException("Could not create context cache");
        File temporary = new File(parent, target.getName() + "." + UUID.randomUUID() + ".tmp");
        byte[] hash = document.hash.getBytes(StandardCharsets.US_ASCII);
        byte[] json = document.json.getBytes(StandardCharsets.UTF_8);
        try (DataOutputStream output = new DataOutputStream(new GZIPOutputStream(new FileOutputStream(temporary)))) {
            output.writeLong(document.capturedAt);
            output.writeInt(hash.length); output.write(hash);
            output.writeInt(json.length); output.write(json);
        }
        if (!temporary.renameTo(target)) {
            temporary.delete();
            throw new java.io.IOException("Could not commit context cache");
        }
    }

    static ContextSync.Document load(Context context, String environmentId, String sessionId) {
        File source = path(context, environmentId, sessionId);
        if (!source.isFile()) return null;
        try (DataInputStream input = new DataInputStream(new GZIPInputStream(new FileInputStream(source)))) {
            long capturedAt = input.readLong();
            int hashLength = input.readInt();
            if (hashLength != 64) throw new java.io.IOException("Invalid cache hash");
            byte[] hash = new byte[hashLength]; input.readFully(hash);
            int jsonLength = input.readInt();
            if (jsonLength < 0 || jsonLength > 64 * 1024 * 1024) throw new java.io.IOException("Invalid cache document");
            byte[] json = new byte[jsonLength]; input.readFully(json);
            ContextSync.Document document = new ContextSync.Document(new String(json, StandardCharsets.UTF_8),
                new String(hash, StandardCharsets.US_ASCII), capturedAt);
            if (!ContextSync.hash(document.json).equals(document.hash)) throw new java.io.IOException("Damaged cache document");
            return document;
        } catch (Exception failure) {
            source.delete();
            return null;
        }
    }

    static void remove(Context context, String environmentId, String sessionId) {
        path(context, environmentId, sessionId).delete();
    }

    private static File path(Context context, String environmentId, String sessionId) {
        String safeEnvironment = environmentId.replaceAll("[^a-z0-9-]", "_");
        String safeSession = sessionId.replaceAll("[^0-9a-fA-F-]", "_");
        return new File(new File(context.getFilesDir(), "context-cache/" + safeEnvironment), safeSession + ".json.gz");
    }
}

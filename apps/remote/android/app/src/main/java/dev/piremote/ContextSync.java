package dev.piremote;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

final class ContextSync {
    private ContextSync() {}

    static final class Document {
        final String json;
        final String hash;
        final long capturedAt;
        Document(String json, String hash, long capturedAt) {
            this.json = json;
            this.hash = hash;
            this.capturedAt = capturedAt;
        }
    }

    static Document update(Document current, JSONObject update) throws Exception {
        if (update == null) return current;
        String kind = update.optString("kind");
        long capturedAt = update.optLong("capturedAt");
        String targetHash = update.optString("hash");
        if ("clear".equals(kind)) return null;
        if ("full".equals(kind)) {
            String document = update.getString("document");
            verify(document.getBytes(StandardCharsets.UTF_8), targetHash);
            return new Document(document, targetHash, capturedAt);
        }
        if (!"splice".equals(kind) || current == null) throw new IllegalStateException("Context resynchronization required");
        JSONObject splice = update.getJSONObject("splice");
        if (!targetHash.equals(splice.getString("targetHash"))) throw new IllegalStateException("Context update hash does not match splice");
        return splice(current, capturedAt, splice.getString("baseHash"), targetHash,
            splice.getInt("prefixBytes"), splice.getInt("deleteBytes"), splice.getString("insertBase64"));
    }

    static Document splice(Document current, long capturedAt, String baseHash, String targetHash,
                           int prefix, int deleted, String insertBase64) throws Exception {
        if (current == null || !current.hash.equals(baseHash)) throw new IllegalStateException("Context splice base does not match");
        byte[] source = current.json.getBytes(StandardCharsets.UTF_8);
        if (prefix < 0 || deleted < 0 || prefix + deleted > source.length) throw new IllegalStateException("Context splice range is invalid");
        byte[] inserted = Base64.getDecoder().decode(insertBase64);
        ByteArrayOutputStream output = new ByteArrayOutputStream(source.length - deleted + inserted.length);
        output.write(source, 0, prefix);
        output.write(inserted);
        output.write(source, prefix + deleted, source.length - prefix - deleted);
        byte[] result = output.toByteArray();
        verify(result, targetHash);
        return new Document(new String(result, StandardCharsets.UTF_8), targetHash, capturedAt);
    }

    static String hash(String value) throws Exception { return hash(value.getBytes(StandardCharsets.UTF_8)); }

    static String hash(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder text = new StringBuilder(64);
        for (byte valueByte : digest) text.append(String.format("%02x", valueByte & 0xff));
        return text.toString();
    }

    private static void verify(byte[] value, String expected) throws Exception {
        String actual = hash(value);
        if (!actual.equals(expected)) throw new IllegalStateException("Context hash verification failed");
    }
}

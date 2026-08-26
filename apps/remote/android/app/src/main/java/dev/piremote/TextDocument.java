package dev.piremote;

import java.nio.charset.StandardCharsets;

final class TextDocument {
    private TextDocument() {}

    static String fileName(String value) {
        String name = value == null ? "" : value.trim();
        if (name.isEmpty()) return "pasted-text.txt";
        return name.matches(".*\\.[^./\\\\]+$") ? name : name + ".txt";
    }

    static byte[] utf8(String value) {
        return (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
    }
}

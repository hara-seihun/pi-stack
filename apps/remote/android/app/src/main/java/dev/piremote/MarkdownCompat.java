package dev.piremote;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class MarkdownCompat {
    private static final Pattern REMOTE_IMAGE = Pattern.compile("<pi-remote-image\\s+src=[\"']([^\"']+)[\"']\\s*/\\s*>", Pattern.CASE_INSENSITIVE);

    private MarkdownCompat() {}

    static String normalizeLatexDelimiters(String value) {
        value = normalizeImages(value == null ? "" : value);
        // The web renderer accepts both dollar and bracket LaTeX delimiters.
        // Markwon/JLatexMath accepts dollars, so translate bracket delimiters
        // outside fenced and inline code to keep Android rendering equivalent.
        StringBuilder output = new StringBuilder(value.length());
        boolean fenced = false;
        char fenceCharacter = 0;
        int fenceLength = 0;
        int inlineCodeLength = 0;
        boolean singleDollarMath = false;
        boolean lineStart = true;
        for (int i = 0; i < value.length();) {
            if (lineStart) {
                int marker = i;
                while (marker < value.length() && marker - i < 3 && value.charAt(marker) == ' ') marker++;
                if (marker < value.length() && (value.charAt(marker) == '`' || value.charAt(marker) == '~')) {
                    char character = value.charAt(marker);
                    int end = marker;
                    while (end < value.length() && value.charAt(end) == character) end++;
                    int length = end - marker;
                    if ((!fenced && length >= 3) || (fenced && character == fenceCharacter && length >= fenceLength)) {
                        output.append(value, i, end);
                        i = end;
                        if (fenced) { fenced = false; fenceCharacter = 0; fenceLength = 0; }
                        else { fenced = true; fenceCharacter = character; fenceLength = length; }
                        lineStart = false;
                        continue;
                    }
                }
            }
            char character = value.charAt(i);
            if (character == '\n') {
                output.append(character); i++; lineStart = true; continue;
            }
            if (fenced) {
                output.append(character); i++; lineStart = false; continue;
            }
            lineStart = false;
            if (character == '`') {
                int end = i;
                while (end < value.length() && value.charAt(end) == '`') end++;
                int length = end - i;
                if (inlineCodeLength == 0) inlineCodeLength = length;
                else if (inlineCodeLength == length) inlineCodeLength = 0;
                output.append(value, i, end); i = end; continue;
            }
            if (inlineCodeLength == 0 && character == '\\' && i + 1 < value.length()) {
                char delimiter = value.charAt(i + 1);
                if (delimiter == '(' || delimiter == ')') {
                    // JLatexMath's inline processor recognizes $$...$$.
                    // Normalize both TeX \(...\) and Markdown $...$ to that
                    // delimiter; a single dollar is ordinary text to it.
                    output.append("$$"); i += 2; continue;
                }
                if (delimiter == '[' || delimiter == ']') {
                    output.append("$$"); i += 2; continue;
                }
            }
            if (inlineCodeLength == 0 && character == '$') {
                int runEnd = i + 1;
                while (runEnd < value.length() && value.charAt(runEnd) == '$') runEnd++;
                int runLength = runEnd - i;
                if (runLength >= 2) {
                    output.append(value, i, runEnd); i = runEnd; continue;
                }
                if (!isEscaped(value, i)) {
                    boolean delimiter = singleDollarMath
                        ? isSingleDollarClose(value, i)
                        : isSingleDollarOpen(value, i) && hasSingleDollarClose(value, i + 1);
                    if (delimiter) {
                        output.append("$$");
                        singleDollarMath = !singleDollarMath;
                        i++;
                        continue;
                    }
                }
            }
            output.append(character); i++;
        }
        return output.toString();
    }

    private static String normalizeImages(String value) {
        Matcher matcher = REMOTE_IMAGE.matcher(value);
        StringBuffer output = new StringBuffer();
        String base = BuildConfig.SERVER_URL.endsWith("/") ? BuildConfig.SERVER_URL.substring(0, BuildConfig.SERVER_URL.length() - 1) : BuildConfig.SERVER_URL;
        while (matcher.find()) {
            String path = URLEncoder.encode(matcher.group(1), StandardCharsets.UTF_8);
            matcher.appendReplacement(output, Matcher.quoteReplacement("\n\n![Presented image](" + base + "/v1/images?path=" + path + ")\n\n"));
        }
        matcher.appendTail(output);
        return output.toString();
    }

    private static boolean isEscaped(String value, int index) {
        int backslashes = 0;
        for (int i = index - 1; i >= 0 && value.charAt(i) == '\\'; i--) backslashes++;
        return (backslashes & 1) == 1;
    }

    private static boolean isSingleDollarOpen(String value, int index) {
        if (index + 1 >= value.length() || Character.isWhitespace(value.charAt(index + 1))) return false;

        // A dollar immediately followed by a number is overwhelmingly a price in chat
        // prose ("$300 B", "$1.4 trillion"). Keep it literal unless the matching
        // delimiter is attached to that same token, as in "$10^9$".
        if (Character.isDigit(value.charAt(index + 1))) {
            for (int i = index + 2; i < value.length() && !Character.isWhitespace(value.charAt(i)); i++) {
                if (value.charAt(i) == '$' && !isEscaped(value, i)) return true;
            }
            return false;
        }
        return true;
    }

    private static boolean isSingleDollarClose(String value, int index) {
        if (index == 0 || Character.isWhitespace(value.charAt(index - 1))) return false;
        // "$5" in prose must not close an earlier unmatched math opener.
        return index + 1 >= value.length() || !Character.isDigit(value.charAt(index + 1));
    }

    private static boolean hasSingleDollarClose(String value, int start) {
        for (int i = start; i < value.length() && value.charAt(i) != '\n'; i++) {
            if (value.charAt(i) != '$' || isEscaped(value, i)) continue;
            int runEnd = i + 1;
            while (runEnd < value.length() && value.charAt(runEnd) == '$') runEnd++;
            if (runEnd - i == 1 && isSingleDollarClose(value, i)) return true;
            i = runEnd - 1;
        }
        return false;
    }
}

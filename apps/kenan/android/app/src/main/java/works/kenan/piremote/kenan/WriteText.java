package works.kenan.piremote.kenan;

final class WriteText {
    record Insertion(String text, int start, int end) {}
    record Correction(String inserted, String replacement) {}

    static Insertion insert(String original, int selectionStart, int selectionEnd, String dictated) {
        int start = selectionStart < 0 ? original.length() : Math.min(original.length(), selectionStart);
        int end = selectionEnd < 0 ? start : Math.min(original.length(), selectionEnd);
        if (start > end) { int swap = start; start = end; end = swap; }
        String before = original.substring(0, start);
        String after = original.substring(end);
        String prefix = !before.isEmpty() && !Character.isWhitespace(before.charAt(before.length() - 1))
            && !dictated.isEmpty() && Character.isLetterOrDigit(dictated.charAt(0)) ? " " : "";
        String suffix = !after.isEmpty() && Character.isLetterOrDigit(after.charAt(0))
            && !dictated.isEmpty() && Character.isLetterOrDigit(dictated.charAt(dictated.length() - 1)) ? " " : "";
        int insertedStart = before.length() + prefix.length();
        return new Insertion(before + prefix + dictated + suffix + after, insertedStart, insertedStart + dictated.length());
    }

    // Compare an observed edit to the inserted span without learning unrelated edits elsewhere.
    static Correction changedWord(String before, String after, int spanStart, int spanEnd) {
        if (spanStart < 0 || spanEnd > before.length() || spanStart >= spanEnd) return null;
        int prefix = 0;
        while (prefix < before.length() && prefix < after.length() && before.charAt(prefix) == after.charAt(prefix)) prefix++;
        int suffix = 0;
        while (suffix < before.length() - prefix && suffix < after.length() - prefix
            && before.charAt(before.length() - 1 - suffix) == after.charAt(after.length() - 1 - suffix)) suffix++;
        int oldEnd = before.length() - suffix;
        if (prefix >= spanEnd || oldEnd <= spanStart || prefix < spanStart || oldEnd > spanEnd) return null;
        int wordStart = prefix;
        while (wordStart > spanStart && Character.isLetterOrDigit(before.charAt(wordStart - 1))) wordStart--;
        int wordEnd = oldEnd;
        while (wordEnd < spanEnd && Character.isLetterOrDigit(before.charAt(wordEnd))) wordEnd++;
        int newEnd = after.length() - suffix;
        String inserted = before.substring(wordStart, wordEnd);
        String replacement = after.substring(wordStart, prefix) + after.substring(prefix, newEnd) + before.substring(oldEnd, wordEnd);
        if (inserted.isBlank() || replacement.isBlank() || inserted.equals(replacement)
            || inserted.length() > 80 || replacement.length() > 80
            || !inserted.matches("[\\p{L}\\p{N}'-]+") || !replacement.matches("[\\p{L}\\p{N}'-]+")) return null;
        return new Correction(inserted, replacement);
    }
}

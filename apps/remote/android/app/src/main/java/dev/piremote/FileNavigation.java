package dev.piremote;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class FileNavigation {
    static final class Crumb {
        final String label;
        final String path;

        Crumb(String label, String path) {
            this.label = label;
            this.path = path;
        }
    }

    private FileNavigation() {}

    static String parent(String path) {
        if (path == null || path.isEmpty() || "/".equals(path)) return "/";
        int end = path.length();
        while (end > 1 && path.charAt(end - 1) == '/') end--;
        int separator = path.lastIndexOf('/', end - 1);
        return separator <= 0 ? "/" : path.substring(0, separator);
    }

    static List<Crumb> crumbs(String path) {
        if (path == null || path.isEmpty() || path.charAt(0) != '/') return Collections.emptyList();
        List<Crumb> result = new ArrayList<>();
        result.add(new Crumb("/", "/"));
        StringBuilder current = new StringBuilder();
        for (String part : path.split("/")) {
            if (part.isEmpty()) continue;
            current.append('/').append(part);
            result.add(new Crumb(part, current.toString()));
        }
        return result;
    }
}

package dev.piremote;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class FileNavigationTest {
    @Test public void rootNeverNavigatesAboveRoot() {
        assertEquals("/", FileNavigation.parent("/"));
        assertEquals("/", FileNavigation.parent("/home"));
        assertEquals("/home", FileNavigation.parent("/home/kenan/"));
    }

    @Test public void breadcrumbsRetainAbsolutePaths() {
        List<FileNavigation.Crumb> crumbs = FileNavigation.crumbs("/home/kenan/My Files");
        assertEquals(List.of("/", "home", "kenan", "My Files"),
            crumbs.stream().map(crumb -> crumb.label).toList());
        assertEquals(List.of("/", "/home", "/home/kenan", "/home/kenan/My Files"),
            crumbs.stream().map(crumb -> crumb.path).toList());
        assertTrue(FileNavigation.crumbs("relative").isEmpty());
    }
}

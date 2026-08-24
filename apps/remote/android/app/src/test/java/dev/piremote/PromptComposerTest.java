package dev.piremote;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PromptComposerTest {
    @Test public void appendsInternalPathsAfterTypedText() {
        assertEquals(
            "Review these.\n\nThe following files were attached to this message:\n- /home/alex/ingestion/a.pdf\n- /home/alex/ingestion/b.csv",
            PromptComposer.compose("Review these.", Arrays.asList(
                "/home/alex/ingestion/a.pdf", "/home/alex/ingestion/b.csv"
            ))
        );
    }

    @Test public void permitsAttachmentOnlyMessages() {
        assertEquals(
            "The following files were attached to this message:\n- /home/alex/ingestion/photo.png",
            PromptComposer.compose("", Collections.singletonList("/home/alex/ingestion/photo.png"))
        );
    }

    @Test public void restoresEditedQueuedMessageIntoAnEmptyComposer() {
        assertEquals("queued content", PromptComposer.restoreDraft("queued content", ""));
    }

    @Test public void preservesAConcurrentDraftWhenRestoringQueuedContent() {
        assertEquals(
            "queued content\n\nnew draft",
            PromptComposer.restoreDraft("queued content", "new draft")
        );
    }

    @Test public void listsOnlySkillsAndNothingNamedForMcp() {
        assertTrue(PromptComposer.commandListed("skill:research-news-summary", "skill"));
        assertFalse(PromptComposer.commandListed("skill:mcp-scripting", "skill"));
        assertFalse(PromptComposer.commandListed("mcp__math__attack", "extension"));
        assertFalse(PromptComposer.commandListed("mcp-auth", "extension"));
        assertFalse(PromptComposer.commandListed("cursor.usage", "extension"));
        assertFalse(PromptComposer.commandListed("compact", "builtin"));
    }

    @Test public void matchesSkillCommandsBySkillName() {
        assertTrue(PromptComposer.commandMatches("skill:research-news-summary", "re"));
        assertTrue(PromptComposer.commandMatches("skill:research-news-summary", "skill"));
        assertFalse(PromptComposer.commandMatches("skill:research-news-summary", "news"));
    }

    @Test public void skillLabelsOmitDescriptions() {
        assertEquals(
            "/skill:research-news-summary",
            PromptComposer.commandLabel(
                "skill:research-news-summary",
                "A long skill description",
                "skill"
            )
        );
        assertEquals(
            "/compact   Compact the current conversation context",
            PromptComposer.commandLabel(
                "compact",
                "Compact the current conversation context",
                "builtin"
            )
        );
    }
}

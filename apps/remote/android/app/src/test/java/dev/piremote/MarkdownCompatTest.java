package dev.piremote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class MarkdownCompatTest {
    @Test public void convertsRemoteFileTagsToSessionDownloadLinks() {
        String value = MarkdownCompat.normalizeLatexDelimiters(
            "Result\n<pi-remote-file src=\"/home/alex/report [final].pdf\" />",
            "12345678-abcd-4abc-8abc-1234567890ab"
        );
        assertEquals(
            "Result\n\n\n[report &#91;final&#93;.pdf](" + BuildConfig.LOCAL_SERVER_URL
                + "/v1/sessions/12345678-abcd-4abc-8abc-1234567890ab/files?path=%2Fhome%2Falex%2Freport+%5Bfinal%5D.pdf)\n\n",
            value
        );
    }

    @Test public void leavesRemoteFileTagsAloneWithoutAnInteractiveSession() {
        String value = "<pi-remote-file src=\"/home/alex/report.pdf\" />";
        assertEquals(value, MarkdownCompat.normalizeLatexDelimiters(value));
    }

    @Test public void convertsWebBracketLatexDelimiters() {
        assertEquals(
            "Inline $$a+b$$ and display $$\\int_0^1 x dx$$.",
            MarkdownCompat.normalizeLatexDelimiters("Inline \\(a+b\\) and display \\[\\int_0^1 x dx\\].")
        );
    }

    @Test public void preservesBracketDelimitersInsideCode() {
        String markdown = "`\\(inline code\\)`\n\n```tex\n\\[fenced code\\]\n```\n\n\\(math\\)";
        String expected = "`\\(inline code\\)`\n\n```tex\n\\[fenced code\\]\n```\n\n$$math$$";
        assertEquals(expected, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }

    @Test public void convertsSingleDollarInlineMathForJLatexMath() {
        assertEquals(
            "Inline $$Q_5$$ and $$a+b$$.",
            MarkdownCompat.normalizeLatexDelimiters("Inline $Q_5$ and $a+b$.")
        );
    }

    @Test public void preservesDisplayEscapedAndUnmatchedDollars() {
        String markdown = "$$x^2$$ and `\\$code\\$` and \\$5 and $unfinished";
        assertEquals(markdown, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }

    @Test public void preservesCurrencyAmountsInProse() {
        String markdown = "The lab committed **$1.4 trillion**: **$300 B** with Oracle, **$250 B** with Microsoft, and **$100 B** more.";
        assertEquals(markdown, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }

    @Test public void currencyDoesNotInterfereWithRealMath() {
        String markdown = "Costs $5 and $10; equations $a+b$ and $10^9$ still render.";
        String expected = "Costs $5 and $10; equations $$a+b$$ and $$10^9$$ still render.";
        assertEquals(expected, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }

    @Test public void doesNotPairMathAcrossLinesOrWithLaterCurrency() {
        String markdown = "Unmatched $x\nCosts $5 but then $a+b$.";
        String expected = "Unmatched $x\nCosts $5 but then $$a+b$$.";
        assertEquals(expected, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }

    @Test public void supportsLongerBacktickSpansAndTildeFences() {
        String markdown = "``\\(code\\)``\n~~~\n\\[code\\]\n~~~\n\\[math\\]";
        String expected = "``\\(code\\)``\n~~~\n\\[code\\]\n~~~\n$$math$$";
        assertEquals(expected, MarkdownCompat.normalizeLatexDelimiters(markdown));
    }
}

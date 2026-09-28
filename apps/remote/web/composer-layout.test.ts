import { expect, test } from "bun:test";
import { resizeComposerPrompt } from "./src/Composer";

test("composer measurement cannot amplify a stretched grid textarea", () => {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    lineHeight: "22px", fontSize: "16px", paddingTop: "10px", paddingBottom: "10px",
    borderTopWidth: "0px", borderBottomWidth: "0px",
  })) as typeof getComputedStyle;
  try {
    const style = { height: "44px", overflowY: "hidden" };
    let contentHeight = 44;
    const textarea = {
      style,
      get scrollHeight() { return style.height === "auto" ? 2000 : contentHeight; },
      get clientHeight() { return Number.parseFloat(style.height); },
    } as unknown as HTMLTextAreaElement;
    for (let i = 0; i < 4; i++) {
      resizeComposerPrompt(textarea, 700);
      expect(style.height).toBe("44px");
      expect(style.overflowY).toBe("hidden");
    }
    contentHeight = 900;
    resizeComposerPrompt(textarea, 700);
    expect(style.height).toBe("152px");
    expect(style.overflowY).toBe("auto");
    contentHeight = 44;
    resizeComposerPrompt(textarea, 700);
    expect(style.height).toBe("44px");
  } finally {
    globalThis.getComputedStyle = previous;
  }
});

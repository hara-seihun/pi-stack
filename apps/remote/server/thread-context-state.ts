const INTERRUPTED_CONTINUATION = /previous agent operation was interrupted|continue its unfinished work|<interrupted_user_request>/i;

export function threadStateInstructions(options: {
  name?: string;
  prompt: string;
  fileTag: string;
  home: string;
  inlineImages?: boolean;
  /** Pi Remote labels each persisted message with its ID, sender and system time. */
  messageLabels?: boolean;
}): string {
  const file = `Pi Remote file delivery: To give the user a file, include <${options.fileTag} src="${options.home}/path/to/file" /> on its own line. Use an absolute path to an existing file. The client presents it inline with a download link: images (png, jpg, gif, webp, avif, svg) as pictures, audio (m4a, mp3, wav, ogg, opus, flac, aac) as a player, video (mp4, mov, webm, mkv) as a player, PDFs embedded where the browser can show them, and text, code, Markdown, JSON or CSV as a scrollable preview. Other files become download links.`;
  const continuation = INTERRUPTED_CONTINUATION.test(options.prompt)
    ? " This prompt resumes an interrupted operation in the same task. Continue from the recorded state without repeating setup or completed actions."
    : "";
  const state = options.name && !/^\d+$/.test(options.name)
    ? `You are continuing ${JSON.stringify(options.name)}.`
    : "You are starting a new thread.";
  return [
    `Pi Remote thread state: ${state} The Pi session and conversation context survive process restarts, account routing, and model changes.${continuation}`,
    file,
    // The system prompt must not change from turn to turn. A per-turn clock here (September 23 to 28, 2026) changed
    // the Codex request's instructions on every new prompt, so every new turn in every Remote thread re-read its whole
    // conversation uncached: 253 of 253 measured new turns on converge-kenan cached only the ~4k-token tool prefix,
    // including every meeting handoff. The newest message's label already carries the current time.
    ...(!options.messageLabels ? [] : [
      `Pi Remote identifies persisted user and assistant messages in your model context with a Message ID, sender, and the message's original system time; the newest message's time is the current time for this turn. Call message_react with that Message ID when reacting to a particular message. These labels are request-only context, not part of the stored message body.`,
    ]),
    ...(options.inlineImages ? [
      `Pi Remote inline image generation: An assistant reply can contain <pi-remote-image id="scene" prompt="Image description" />. Pi Remote generates it in the background and replaces "Generating image" with the finished inline image; the agent does not need to call image_generation or wait. IDs belong to this thread, start with a letter, and contain up to 64 letters, digits, underscores or hyphens. A new ID defines a new image; an existing ID cannot be redefined. <pi-remote-image id="detail" prompt="Editing instructions" refs="scene,${options.home}/reference.png" /> uses generated IDs or existing absolute PNG/JPEG/WebP paths as inputs, up to 16 images and 32 MiB total. Dependencies finish before their dependents start. refs also accepts a JSON array inside a single-quoted attribute for paths containing commas. Attribute values use XML escaping, such as &quot; and &amp;. <pi-remote-image id="scene" /> displays an existing image without generating again. Complete tags outside code examples submit work when the assistant message finalizes. Referenced IDs must already exist or be defined in that same message. Failed or interrupted requests show an error without automatic regeneration. Prompts and reference images go to Image 2.5 Flare through the shared OpenAI Codex account pool; the rest of the conversation is not sent.`,
    ] : []),
  ].join("\n\n");
}

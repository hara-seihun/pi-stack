const INTERRUPTED_CONTINUATION = /previous agent operation was interrupted|continue its unfinished work|<interrupted_user_request>/i;

export function threadStateInstructions(options: {
  name?: string;
  prompt: string;
  fileTag: string;
  home: string;
}): string {
  const file = `Pi Remote file delivery: To give the user a file, include <${options.fileTag} src="${options.home}/path/to/file" /> on its own line. Use an absolute path to an existing file. The client turns the tag into a download link, or shows the picture inline when the file is an image (png, jpg, gif, webp, avif, svg).`;
  const threads = "Other Pi Remote threads are available through `read-thread`. Run `read-thread --list` to find one, `read-thread TITLE` to read its active conversation and actions locally without model calls, or `read-thread --path TITLE` to print its exact JSONL path. Use this instead of `read-condensed-session` unless semantic condensation is specifically needed.";
  const continuation = INTERRUPTED_CONTINUATION.test(options.prompt)
    ? " This prompt resumes an interrupted operation in the same task. Continue from the recorded state without repeating setup or completed actions."
    : "";
  const state = options.name && !/^\d+$/.test(options.name)
    ? `You are continuing ${JSON.stringify(options.name)}.`
    : "You are starting a new thread.";
  return [
    `Pi Remote thread state: ${state} The Pi session and conversation context survive process restarts, account routing, and model changes.${continuation}`,
    file,
    threads,
  ].join("\n\n");
}

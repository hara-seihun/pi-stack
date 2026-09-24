export type FileKind = "image" | "audio" | "video" | "markdown" | "text" | "pdf" | "binary";

const imageExtensions = new Set(["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
// Formats a current Chromium, Android WebView or Safari can decode in a media
// element. A file whose codec the browser lacks still shows its controls and
// download link, which is no worse than the link alone.
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"]);
const videoExtensions = new Set(["m4v", "mkv", "mov", "mp4", "ogv", "webm"]);
const markdownExtensions = new Set(["markdown", "md", "mdown", "mkdn", "mkd"]);
const textExtensions = new Set([
  "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "diff", "env", "go", "h", "hpp", "hs", "html", "ini", "java", "jl", "js", "json", "jsonl", "jsx", "kt", "lean", "less", "log", "lua", "mjs", "ndjson", "nix", "patch", "php", "py", "r", "rb", "rs", "rst", "scss", "sh", "sql", "srt", "svelte", "swift", "tex", "toml", "ts", "tsv", "tsx", "txt", "vtt", "vue", "xml", "yaml", "yml", "zig", "zsh",
]);
const textNames = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "readme", "license", "procfile", "gitignore", "gitattributes", "gitmodules", "npmrc", "editorconfig", "prettierrc", "eslintrc"]);

export function fileKind(path: string, contentType = ""): FileKind {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  const extension = name.includes(".") ? name.split(".").at(-1) || "" : "";
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  if (markdownExtensions.has(extension)) return "markdown";
  if (extension === "pdf") return "pdf";
  if (textExtensions.has(extension) || textNames.has(name) || (name.startsWith(".") && !extension.includes("."))) return "text";
  const type = contentType.toLowerCase().split(";", 1)[0];
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml") || type === "application/javascript" || type === "application/x-sh") return "text";
  return "binary";
}

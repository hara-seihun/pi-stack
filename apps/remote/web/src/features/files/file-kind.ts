export type FileKind = "image" | "markdown" | "text" | "pdf" | "binary";

const imageExtensions = new Set(["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const markdownExtensions = new Set(["markdown", "md", "mdown", "mkdn", "mkd"]);
const textExtensions = new Set([
  "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "diff", "env", "go", "h", "hpp", "html", "ini", "java", "js", "json", "jsx", "kt", "less", "log", "lua", "mjs", "py", "rb", "rs", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);
const textNames = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "readme", "license", "procfile", "gitignore", "gitattributes", "gitmodules", "npmrc", "editorconfig", "prettierrc", "eslintrc"]);

export function fileKind(path: string, contentType = ""): FileKind {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  const extension = name.includes(".") ? name.split(".").at(-1) || "" : "";
  if (imageExtensions.has(extension)) return "image";
  if (markdownExtensions.has(extension)) return "markdown";
  if (extension === "pdf") return "pdf";
  if (textExtensions.has(extension) || textNames.has(name) || (name.startsWith(".") && !extension.includes("."))) return "text";
  const type = contentType.toLowerCase().split(";", 1)[0];
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml") || type === "application/javascript" || type === "application/x-sh") return "text";
  return "binary";
}

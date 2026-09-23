// Model glyphs match the Orchestrator catalog icons (astra ⭐, sol ☀️, opus 🎨,
// fable 🪶, luna 🌙); models without an emoji get an initial. Keyed by substring so
// pooled provider aliases and full ids like openai-codex-3/gpt-6-sol resolve.
const GLYPHS: [RegExp, string, string][] = [
  [/astra/i, "⭐", "Astra"],
  [/\bsol\b|gpt-6-sol/i, "☀️", "Sol"],
  [/luna/i, "🌙", "Luna"],
  [/opus/i, "🎨", "Opus"],
  [/fable/i, "🪶", "Fable"],
  [/sonnet/i, "S", "Sonnet"],
];

export function modelGlyph(model: string): { glyph: string; label: string; emoji: boolean } {
  for (const [pattern, glyph, label] of GLYPHS) if (pattern.test(model)) return { glyph, label, emoji: /\p{Extended_Pictographic}/u.test(glyph) };
  const short = model.split("/").at(-1) || model;
  return { glyph: (short[0] || "?").toUpperCase(), label: short, emoji: false };
}

export function modelShortName(model: string) {
  return modelGlyph(model).label === model.split("/").at(-1) ? (model.split("/").at(-1) || model) : modelGlyph(model).label;
}

export function ModelGlyph({ model, className = "" }: { model: string; className?: string }) {
  const { glyph, label, emoji } = modelGlyph(model);
  return <span className={`model-glyph${emoji ? " emoji" : " initial"} ${className}`} role="img" aria-label={label} title={label}>{glyph}</span>;
}

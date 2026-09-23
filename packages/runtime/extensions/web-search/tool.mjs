// The agent-facing shape of the tool: its parameters and how results are read back.
import { Type } from "typebox";

/** Exa's categories are the widest set any current backend accepts; unknown values are passed through. */
export const CATEGORIES = ["company", "research paper", "news", "pdf", "github", "tweet", "personal site", "linkedin profile", "financial report"];

export function searchParameters(defaultResults = 8) {
  return Type.Object({
    query: Type.String({ minLength: 1, maxLength: 2000, description: "What to find, written as a description of the wanted page rather than keywords." }),
    numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: `Results to return. Defaults to ${defaultResults}.` })),
    category: Type.Optional(Type.Union(CATEGORIES.map((category) => Type.Literal(category)), { description: "Restrict results to one kind of page." })),
    includeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 25, description: "Only return results from these domains." })),
    excludeDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 25, description: "Drop results from these domains." })),
    startPublishedDate: Type.Optional(Type.String({ description: "ISO date or timestamp; only return pages published at or after it." })),
    text: Type.Optional(Type.Boolean({ description: "Return extracted page text instead of a short excerpt. Costs more and returns much more output; leave it off when the excerpt answers the question." })),
  });
}

function line(result, index) {
  const parts = [`${index + 1}. ${result.title ?? result.url}`, `   ${result.url}`];
  const meta = [result.publishedDate ? String(result.publishedDate).slice(0, 10) : undefined, result.author].filter(Boolean);
  if (meta.length) parts.push(`   ${meta.join(" · ")}`);
  if (result.text) parts.push(result.text.trim().split("\n").map((row) => `   ${row}`).join("\n"));
  else if (result.snippet) parts.push(`   ${result.snippet}`);
  return parts.join("\n");
}

export function formatResults(query, results, notes = [], label = "the web") {
  if (!results.length) {
    const reason = notes?.length ? `\n${notes.join("\n")}` : "";
    return `No ${label} results for ${JSON.stringify(query)}. Try a differently worded query or drop a filter.${reason}`;
  }
  const body = results.map(line).join("\n\n");
  const trailer = notes?.length ? `\n\n${notes.join("\n")}` : "";
  return `${results.length} result${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}\n\n${body}${trailer}`;
}

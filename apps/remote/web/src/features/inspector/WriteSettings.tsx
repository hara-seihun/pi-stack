import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
type Dictionary = { words: string[]; replacements: Array<{ from: string; to: string }> };
import { api } from "../../client";
import { DismissibleError } from "../../dismissible-error";

export function WriteSettings() {
  const [dictionary, setDictionary] = useState<Dictionary | null>(null);
  const [words, setWords] = useState("");
  const [replacements, setReplacements] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api(API.writeDictionary.method, API.writeDictionary.path()).then((value: Dictionary) => {
      if (!active) return;
      setDictionary(value); setWords(value.words.join("\n"));
      setReplacements(value.replacements.map(item => `${item.from} → ${item.to}`).join("\n")); setError("");
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [revision]);
  const save = async () => {
    const rules = replacements.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
      const pair = line.split(/\s*→\s*/);
      if (pair.length !== 2) throw new Error(`Use “from → to” for: ${line}`);
      return { from: pair[0]!, to: pair[1]! };
    });
    setSaving(true); setError("");
    try {
      const saved = await api(API.updateWriteDictionary.method, API.updateWriteDictionary.path(), { words: words.split("\n").map(word => word.trim()).filter(Boolean), replacements: rules });
      setDictionary(saved); setWords(saved.words.join("\n")); setReplacements(saved.replacements.map((item: { from: string; to: string }) => `${item.from} → ${item.to}`).join("\n"));
    } catch (cause) { setError(String(cause)); } finally { setSaving(false); }
  };
  return <section className="inspector-section"><h3>Write dictionary</h3>
    <p className="muted">Words Write should recognize, and corrections from what it heard to what you meant.</p>
    <DismissibleError message={error} />
    {!dictionary && <button type="button" onClick={() => setRevision(value => value + 1)}>Retry loading dictionary</button>}
    {dictionary && <>
      <label>Words (one per line)<textarea value={words} onChange={event => setWords(event.target.value)} rows={4} /></label>
      <label>Replacements (one “from → to” per line)<textarea value={replacements} onChange={event => setReplacements(event.target.value)} rows={4} /></label>
      <button type="button" disabled={saving} onClick={() => { void save().catch(cause => setError(String(cause))); }}>{saving ? "Saving…" : "Save dictionary"}</button>
    </>}
  </section>;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerUnlockHandler } from "./client";
import { fetchPersonChooser } from "./native";
import { DismissibleError } from "./dismissible-error";

export function UnlockDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((key: string) => void) | null>(null);
  const [people, setPeople] = useState<Array<{ user: string; displayName?: string; requiresUnlock?: boolean }>>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  const [custody, setCustody] = useState<{ locked: boolean; message: string } | null>(null);
  useEffect(() => {
    registerUnlockHandler(async (nextMessage) => {
      setMessage(nextMessage);
      setKey("");
      try {
        const response = await fetchPersonChooser();
        if (!response.ok) throw new Error(`Person chooser returned HTTP ${response.status}`);
        const result = await response.json();
        setCustody(result?.environment?.custody ?? null);
        const nextPeople = result?.environment?.persons || result?.persons || [];
        const savedUser = window.PiRemotePerson?.get() || "";
        const nextUser = nextPeople.some((person: { user: string }) => person.user === savedUser) ? savedUser : nextPeople[0]?.user || "";
        setPeople(nextPeople);
        setSelectedUser(nextUser);
        window.PiRemotePerson?.set(nextUser);
      } catch (error) { setMessage(`Could not load people: ${String(error)}`); }
      return new Promise<string>((resolve) => { resolver.current = resolve; setActive(true); });
    });
  }, []);
  useLayoutEffect(() => { if (active) dialog.current?.showModal(); }, [active]);
  const requiresKey = people.find(person => person.user === selectedUser)?.requiresUnlock !== false;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if ((requiresKey && !key) || !selectedUser) return;
    resolver.current?.(key);
    resolver.current = null;
    setKey("");
    setActive(false);
    dialog.current?.close();
  };
  return <dialog ref={dialog} className="unlock-dialog" aria-labelledby={active ? "unlock-title" : undefined} onCancel={event => event.preventDefault()}>
    {active && <form className="unlock-form" onSubmit={submit}>
      <h2 id="unlock-title">Pi Remote</h2>
      {requiresKey && <p>{custody ? "Your key proves who you are to Kenan; he retains folder custody." : "Your folder key stays on this device."}</p>}
      {custody?.locked && <p role="status">Kenan's custody is locked after a restart. {custody.message}</p>}
      {people.length > 0 && <div className="unlock-field"><label htmlFor="unlock-person">Person</label><select id="unlock-person" value={selectedUser} onChange={(event) => { setSelectedUser(event.target.value); setKey(""); window.PiRemotePerson?.set(event.target.value); }}>{people.map((person) => <option key={person.user} value={person.user}>{person.displayName || person.user}</option>)}</select></div>}
      {requiresKey && <div className="unlock-field"><label htmlFor="unlock-key">Folder key</label><input id="unlock-key" type="password" autoComplete="current-password" spellCheck={false} required value={key} onChange={(event) => setKey(event.target.value)} /></div>}
      <DismissibleError className="unlock-error" message={message} />
      <div className="unlock-actions"><button className="accent" type="submit">{requiresKey ? "Unlock" : "Continue"}</button></div>
    </form>}
  </dialog>;
}

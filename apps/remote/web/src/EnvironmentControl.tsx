import { useEffect, useRef, useState } from "react";
import { fetchPersonChooser, loadEnvironments, type EnvironmentState } from "./native";
import type { Endpoint } from "./router-auth";
import { auth } from "./person";
import { DismissibleError } from "./dismissible-error";
import "./EnvironmentControl.css";

interface Person { user: string; displayName: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function EnvironmentControl() {
  const [person, setPerson] = useState(() => window.PiRemotePerson.get());
  const [accountSignIn, setAccountSignIn] = useState(() => Boolean(auth.authentication));
  useEffect(() => {
    const refresh = () => setAccountSignIn(Boolean(auth.authentication));
    window.addEventListener("pi-host-auth", refresh);
    return () => window.removeEventListener("pi-host-auth", refresh);
  }, []);
  const [people, setPeople] = useState<Person[]>([]);
  const [environments, setEnvironments] = useState<Endpoint[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentState | null>(null);
  const [peopleError, setPeopleError] = useState("");
  const [environmentError, setEnvironmentError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const switching = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setPeopleError("");
    void (async () => {
      try {
        const response = await fetchPersonChooser();
        if (!response.ok) throw new Error(`Person chooser returned HTTP ${response.status}`);
        const result = await response.json();
        const candidates: unknown = result?.environment?.persons ?? result?.persons;
        if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate.user !== "string" || !candidate.user || typeof candidate.displayName !== "string")) {
          throw new Error("Router returned an invalid person list");
        }
        if (!cancelled) setPeople(candidates);
      } catch (error) {
        if (!cancelled) setPeopleError(`Could not load people: ${message(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  useEffect(() => {
    const refresh = () => {
      const request = ++revision.current;
      const user = window.PiRemotePerson.get();
      setPerson(user);
      setEnvironment(null);
      setEnvironments([]);
      setEnvironmentError("");
      setSwitchError("");
      setPending("");
      switching.current = false;
      if (!window.PiRemotePerson.session()) {
        setLoading(false);
        setEnvironmentError(auth.authentication ? "Sign in to load environments." : "Folder is locked. Unlock to load environments.");
        return;
      }
      setLoading(true);
      void (async () => {
        try {
          const endpoints = await loadEnvironments();
          if (request !== revision.current) return;
          setEnvironments(endpoints);
          if (!window.KenanRemote) throw new Error("Environment switching is unavailable");
          const state: EnvironmentState = await window.KenanRemote.getState();
          if (request !== revision.current) return;
          setEnvironment(state);
          document.title = `kenan · ${state.name}`;
        } catch (error) {
          if (request === revision.current) setEnvironmentError(`Could not load environments: ${message(error)}`);
        } finally {
          if (request === revision.current) setLoading(false);
        }
      })();
    };
    refresh();
    window.addEventListener("pi-auth", refresh);
    window.addEventListener("pi-person", refresh);
    window.addEventListener("pi-host-auth", refresh);
    return () => {
      revision.current++;
      window.removeEventListener("pi-auth", refresh);
      window.removeEventListener("pi-person", refresh);
      window.removeEventListener("pi-host-auth", refresh);
    };
  }, [attempt]);

  const choose = async (value: string) => {
    if (value === "retry") {
      setAttempt(current => current + 1);
      return;
    }
    if (value.startsWith("person:") && !accountSignIn) {
      const user = value.slice("person:".length);
      if (user === person || !people.some(candidate => candidate.user === user)) return;
      try { window.PiRemotePerson.set(user); }
      catch (error) { setSwitchError(`Could not switch person: ${message(error)}`); }
      return;
    }
    const id = value.slice("environment:".length);
    if (!value.startsWith("environment:") || switching.current || id === environment?.id || !environments.some(candidate => candidate.id === id)) return;
    const request = ++revision.current;
    const user = window.PiRemotePerson.get();
    switching.current = true;
    setPending(id);
    setLoading(false);
    setSwitchError("");
    try {
      if (!window.KenanRemote) throw new Error("Environment switching is unavailable");
      const selected = await window.KenanRemote.select({ id, user });
      if (request !== revision.current || user !== window.PiRemotePerson.get()) return;
      if (!selected) throw new Error("Environment selection was not confirmed");
      location.reload();
    } catch (error) {
      if (request === revision.current) setSwitchError(`Could not switch environment: ${message(error)}`);
    } finally {
      if (request === revision.current) {
        switching.current = false;
        setPending("");
      }
    }
  };

  const errors = [peopleError, environmentError, switchError].filter(Boolean);
  return <div className="environment-picker">
    <select aria-label={accountSignIn ? "Environment" : "Environment or person"}
      value={pending ? `environment:${pending}` : environment ? `environment:${environment.id}` : ""}
      onChange={event => { void choose(event.target.value); }}>
      {!environment && !pending && <option value="" disabled>{loading ? "Loading environments…" : accountSignIn ? "Choose an environment" : "Choose an environment or person"}</option>}
      {environments.map(candidate => <option key={`environment:${candidate.id}`} value={`environment:${candidate.id}`} disabled={Boolean(pending) || loading}>{candidate.name}</option>)}
      {people.filter(candidate => !accountSignIn && candidate.user !== person).map(candidate => <option key={`person:${candidate.user}`} value={`person:${candidate.user}`}>{candidate.displayName || candidate.user}</option>)}
      {errors.length > 0 && <option value="retry" disabled={Boolean(pending)}>Reconnect</option>}
    </select>
    {pending && <div className="environment-picker-status" role="status">Switching environment…</div>}
    <DismissibleError message={peopleError} resetKey={`${person}:${attempt}`} className="environment-picker-error" dismissLabel="Dismiss person list error" />
    <DismissibleError message={environmentError} resetKey={`${person}:${attempt}`} className="environment-picker-error" dismissLabel="Dismiss environment list error" />
    <DismissibleError message={switchError} resetKey={`${person}:${attempt}`} className="environment-picker-error" dismissLabel="Dismiss switching error" />
  </div>;
}

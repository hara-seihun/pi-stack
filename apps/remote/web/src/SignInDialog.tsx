import { useEffect, useRef, useState } from "react";
import { ensureUnlocked, registerSignInHandler } from "./client";
import { beginSignIn } from "./native";
import { auth } from "./person";
import { DismissibleError } from "./dismissible-error";
import "./SignInDialog.css";

export function SignInDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const unregister = registerSignInHandler(error => {
      setMessage(error);
      dialog.current?.showModal();
    });
    const authenticated = () => { if (auth.session) dialog.current?.close(); };
    window.addEventListener("pi-auth", authenticated);
    return () => { unregister(); window.removeEventListener("pi-auth", authenticated); };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    setMessage("");
    try { await operation(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="sign-in-dialog" aria-labelledby="sign-in-title" onCancel={event => event.preventDefault()}>
    <h2 id="sign-in-title">Pi Remote</h2>
    <DismissibleError message={message} />
    <div className="sign-in-actions">
      {message && <button type="button" disabled={pending} onClick={() => void run(ensureUnlocked)}>Retry session</button>}
      <button type="button" disabled={pending} onClick={() => void run(beginSignIn)}>{auth.authentication?.label || "Sign in"}</button>
    </div>
  </dialog>;
}

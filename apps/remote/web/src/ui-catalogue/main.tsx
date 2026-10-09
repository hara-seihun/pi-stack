import { createRoot } from "react-dom/client";
import { installFixtureTransport } from "./transport";
import "../../styles.css";

installFixtureTransport();
const parameters = new URLSearchParams(location.search);
const bootstraps = import.meta.glob<{ configureSettingsAuthPlatform(caseId: string | null, parameters: URLSearchParams): void }>("./settings-auth-bootstrap.ts");
const bootstrap = bootstraps["./settings-auth-bootstrap.ts"];
if (bootstrap) (await bootstrap()).configureSettingsAuthPlatform(parameters.get("case"), parameters);
await import("../person");
window.PiRemotePerson.set("ui-fixture");
window.PiRemotePerson.acceptSession("ui-fixture", "synthetic-ui-session");
await import("../native");
const { Catalogue } = await import("./Catalogue");
const root = document.getElementById("root");
if (!root) throw new Error("UI catalogue root is missing");
createRoot(root).render(<Catalogue parameters={parameters} />);

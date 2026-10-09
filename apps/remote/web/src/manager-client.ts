import { managerFetch, loadEnvironments } from "./native";
import { createManagerRequest } from "./app/manager-request";

export const requestManager = createManagerRequest({
  identity: () => ({ user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() }),
  environments: loadEnvironments,
  headers: initial => window.PiRemotePerson.headers(initial),
  fetch: managerFetch,
  clearSession: session => window.PiRemotePerson.clearSession(session),
});

# UI fixture workbench

The catalogue renders production components with synthetic contract-valid data. It is a development entry, not shipped app navigation. Android View fixtures have their own [native owner](../../../../kenan/native-ui/README.md).

From the repository root:

```sh
npm run ui:catalogue -w apps/remote
```

Open `http://127.0.0.1:5191/ui-catalogue.html`. Search or choose a case. `?case=CASE_ID&mode=render` gives an undecorated viewport. `?mode=report` and `window.PiUiCatalogue.report()` expose the source revision, registered cases and captured synthetic requests.

Vite binds loopback only and disables HMR so source edits do not reset an interaction midway. Navigate again after an edit; restart when adding a globbed fixture module. It reuses Vite, React and TypeScript.

`contract.ts` owns case/action metadata. Slice modules construct explicit loading, ready, empty and failed states, plus representative long text and multi-item data. Production components and validators remain the state owners.

`transport.ts` replaces fetch before production modules initialize. Each case declares an exact method/path or validating URL matcher with its response producer. Shared fixtures supply synthetic authentication and environment bootstrap. Unknown requests return HTTP501 and appear in the report. WebSockets and cross-origin fetches cannot reach live services. Native fakes reject unavailable methods.

Cases can declare transition actions. `window.PiUiCatalogue.invokeAction(CASE_ID, ACTION_ID)` acts only on the mounted case; unknown owners/actions fail explicitly. The synthetic editor POST target accepts declared fixture tickets, exercising handoff rather than code-server itself.

Use the workbench when a concrete component change needs an interactive rendered state. The case registry and request log describe fixtures, not coverage claims or a standing review queue. No private live data or real phone is used.

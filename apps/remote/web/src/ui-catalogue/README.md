# Typed UI state catalogue

The catalogue renders **actual production components** with synthetic contract-valid data. It is a development entry, not part of the shipped app. Native Android View fixtures have a separate [rendering owner](../../../../kenan/native-ui/README.md).

## Run

From the repository root:

```sh
npm run ui:catalogue -w apps/remote
```

Open `http://127.0.0.1:5191/ui-catalogue.html`. Choose a case, or use `?case=CASE_ID&mode=render` for an undecorated viewport. `?mode=report` and `window.PiUiCatalogue.report()` expose judged coverage, remaining owned compositions, native boundaries, source inventory and unmatched requests. `npm run ui:inventory -w apps/remote` regenerates source discovery/fingerprints without claiming a visual pass.

Vite binds loopback only. HMR is deliberately disabled: concurrent source/receipt edits must not reset a clicked dialog, toast or viewport midway through observation. Navigate explicitly after a source change; restart the catalogue when registering a new globbed module. It uses the existing Vite/React/TypeScript dependencies and no additional screenshot framework.

## Valid states

`contract.ts` owns case metadata and visual receipt vocabulary. Slice modules import production data types, build closed state constructors and use production validators at external boundaries. Finite discriminants are enumerated. Unbounded content uses named generating classes: empty, long/unbroken strings, Unicode, many items, boundary lengths and data-dependent interactions. A parent component's fixture is not evidence that every nested branch or composition was viewed.

`transport.ts` replaces fetch before production modules initialize. Each case explicitly declares its method plus exact path or validating URL matcher and a typed response producer. Synthetic authentication/environment bootstrap routes are shared; case routes take precedence. Undeclared API requests return HTTP501 and appear in the report. WebSockets and cross-origin fetches cannot reach live services. Native bridge fixtures install before the native module and reject unavailable/unknown methods.

The Vite owner also rejects native `/v1/` requests not covered by its exact synthetic image route. The synthetic `/editor/open` POST target accepts only the declared fixture tickets; it proves handoff, expiry and return behavior, **not code-server's UI**. No private live data or real phone is used.

## Review loop

1. Discover an owned component/contract or remaining queue entry; register valid finite variants and representative reachable compositions.
2. Use native `agent_browser` to open the raw case, wait for its intended state, set the viewport, take an interactive snapshot and perform relevant actions. Capture the rendered screenshot. Check artifact verification and actual PNG dimensions.
3. **Read and judge the images.** Inspect hierarchy/readability, action and navigation clarity, loading/waiting/error/empty explanations, overflow, contrast, focus and touch targets. View scroll-dependent content, not just its first screen. A screenshot file or DOM assertion alone is not a judgment.
4. Fix a discovered production defect, navigate to fresh source, repeat the relevant captures and judgments. Keep failed setup/blank captures out of pass receipts.
5. Append a `UiReview` with the exact primary PNG, viewport, OS color preference, status and concrete judgment. The report distinguishes passed, fixed, needs-fix and not-yet-viewed; it never fills omitted cells by inference.
6. Regenerate source inventory. Source/style fingerprints identify owners needing re-review after changes; historical receipts are not automatically promoted to fresh-source passes.

The mandatory registered matrix is phone/tablet/desktop under the product's **dark palette**. Representative reviews also exercise OS light preference: the product does not implement a light theme, and fixtures do not manufacture one. Actual dimensions are recorded in each slice's evidence; viewport category does not assert physical touch hardware. Keyboard focus and interaction require their own observations.

Toasts use the actual production owner. Standalone toast fixtures explicitly hold notices for 30 seconds to permit observation; the production default remains 3 seconds. App Undo-error fixtures exercise the real transient path. Native screenshots of visible password inputs are currently rejected by the browser tool's sensitive-output guard, even with synthetic values; those cells remain unviewed.

## Evidence and scope

The first review's external artifacts live at `/home/kenan/data/pi-ui-review-20261009/`; source receipts are `*-reviews.json`. Native evidence lives in `native/` and `native-editor/`, with their own rendered/visually-judged and lifecycle-absence distinctions. PNGs are not committed into this source catalogue.

`*-remaining.json` is the current owned-state/composition queue. The report also includes the native catalogue's unviewed boundaries. Android OS installer/permission/compositor surfaces and third-party editor/sign-in content are distinguished from owned native request/loading/failure/Close presentation. A full registered matrix means only the declared cases were judged, **not that all owned product compositions are complete**. Continue from the queue and source inventory rather than declaring finite strings or arbitrary cross-products exhaustive.

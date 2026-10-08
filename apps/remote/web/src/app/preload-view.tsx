import { createElement, type ComponentProps, type ComponentType } from "react";
import { assertNever } from "../../../shared/explicit-state";

type LoadResult = { ok: true } | { ok: false; error: Error };
type ViewState<Props extends object> =
  | { kind: "unloaded" }
  | { kind: "loading"; promise: Promise<LoadResult> }
  | { kind: "ready"; component: ComponentType<Props> }
  | { kind: "failed"; error: Error };

/** Intent can resolve a module before React first reads it, without mounting its screen. */
export function preloadView<Module extends { default: ComponentType<any> }>(load: () => Promise<Module>) {
  type Props = ComponentProps<Module["default"]>;
  let state: ViewState<Props> = { kind: "unloaded" };
  const failed = (cause: unknown): LoadResult => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    state = { kind: "failed", error };
    return { ok: false, error };
  };
  const preload = (): Promise<LoadResult> => {
    switch (state.kind) {
      case "loading": return state.promise;
      case "ready": return Promise.resolve({ ok: true });
      case "failed": return Promise.resolve({ ok: false, error: state.error });
      case "unloaded": {
        let loading: ReturnType<typeof load>;
        try { loading = load(); } catch (cause) { return Promise.resolve(failed(cause)); }
        const promise = loading.then(module => {
          state = { kind: "ready", component: module.default };
          return { ok: true } as const;
        }, failed);
        state = { kind: "loading", promise };
        return promise;
      }
    }
    return assertNever(state, "View preload");
  };
  const View = (props: Props) => {
    switch (state.kind) {
      case "ready": return createElement(state.component, props);
      case "failed": throw state.error;
      case "unloaded": throw preload();
      case "loading": throw state.promise;
    }
    return assertNever(state, "View render");
  };
  return Object.assign(View, { preload });
}

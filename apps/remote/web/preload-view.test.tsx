import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { preloadView } from "./src/app/preload-view";

test("preloading shares one import and renders ready props without suspension", async () => {
  let imports = 0;
  let renders = 0;
  let release!: (module: { default: (props: { value: string }) => React.ReactNode }) => void;
  const View = preloadView(() => {
    imports++;
    return new Promise(resolve => { release = resolve; });
  });
  const first = View.preload();
  expect(View.preload()).toBe(first);
  expect(imports).toBe(1);
  expect(renders).toBe(0);
  release({ default: ({ value }) => { renders++; return <span>{value}</span>; } });
  expect(await first).toEqual({ ok: true });
  expect(renders).toBe(0);
  expect(renderToStaticMarkup(<View value="ready" />)).toBe("<span>ready</span>");
  expect(renders).toBe(1);
  expect(await View.preload()).toEqual({ ok: true });
  expect(imports).toBe(1);
});

test("failed code loads remain explicit and reach the render boundary", async () => {
  const error = new Error("chunk unavailable");
  const View = preloadView(() => Promise.reject(error));
  expect(await View.preload()).toEqual({ ok: false, error });
  expect(await View.preload()).toEqual({ ok: false, error });
  expect(() => renderToStaticMarkup(<View />)).toThrow(error);
});

test("a synchronous loader failure is the same explicit failed state", async () => {
  const error = new Error("loader failed");
  const View = preloadView(() => { throw error; });
  expect(await View.preload()).toEqual({ ok: false, error });
  expect(() => renderToStaticMarkup(<View />)).toThrow(error);
});

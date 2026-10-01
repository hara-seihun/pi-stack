import { expect, test } from "bun:test";
import { androidDownloadUrl, offerAndroidApp } from "./src/android-app";

test("APK offers belong to Android phone browsers, not the installed app or iPhones", () => {
  const phone = "Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36";
  expect(offerAndroidApp(phone, false, false)).toBe(true);
  expect(offerAndroidApp(phone, true, false)).toBe(false);
  expect(offerAndroidApp(phone, false, true)).toBe(false);
  expect(offerAndroidApp("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Mobile", false, false)).toBe(false);
  expect(offerAndroidApp("Mozilla/5.0 (X11; Linux x86_64)", false, false)).toBe(false);
});

test("the current manifest supplies a same-origin APK, retaining the browser mount", () => {
  for (const href of ["https://public.test/#/chats", "https://private.test/#/chats", "https://public.test/pi-stack/#/chats"]) {
    const download = new URL(androidDownloadUrl({ release: { fileName: "current-revision.apk" } }, href), href);
    expect(download.origin).toBe(new URL(href).origin);
    expect(download.pathname).toBe(new URL(href).pathname + "v1/app-update/current-revision.apk");
  }
  for (const fileName of ["https://outside.test/file.apk", "../file.apk", "file.apk?session=secret", "file.zip", undefined]) {
    expect(() => androidDownloadUrl({ release: { fileName } }, "https://public.test/")).toThrow();
  }
});

# Pi source packages

These tarballs carry Pi upstream commit `17de82d7bea18a6589677a9761baabc2060c9efb`, the first commit with GPT-6 Astra support. Upstream had not published that commit when we adopted it, so the ordinary npm registry could not reproduce the requested runtime.

`pi-ai` is built from that commit. `pi-coding-agent` includes [session-thinking.patch](session-thinking.patch), which makes thinking defaults apply only when a session has no saved or explicitly supplied level. Model selection and account routing preserve the session level. Changing or removing a per-model startup default does not change the current session. Explicit thinking changes, explicit scoped-model levels, and model capability clamping still apply. The patch includes regression tests.

Both package versions remain `0.85.0`; their filenames alone are not provenance. This file, the source patch, and the tarball hashes in `package-lock.json` identify what we ship. Pi 0.85's CLI imports `@earendil-works/pi-server`, but its coding-agent manifest omits that dependency, so the root manifest pins the matching published server package explicitly.

## Rebuild the coding agent

Take a clean upstream checkout at the commit above. Set `stack` to the absolute path of this pi-stack checkout, then run these commands from the upstream checkout:

```sh
git apply "$stack/vendor/pi/session-thinking.patch"
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p packages/ai/src/providers
tar -xzf "$stack/vendor/pi/earendil-works-pi-ai-0.85.0-17de82d7bea1.tgz" \
  --strip-components=3 -C packages/ai/src/providers package/dist/providers/data
npm run build:offline
npm pack --ignore-scripts --workspace=@earendil-works/pi-coding-agent --pack-destination "$stack/vendor/pi"
mv "$stack/vendor/pi/earendil-works-pi-coding-agent-0.85.0.tgz" \
  "$stack/vendor/pi/earendil-works-pi-coding-agent-0.85.0-session-thinking.tgz"
```

The model data comes from the shipped Pi AI tarball rather than live catalogs, so rebuilding the agent does not silently change model metadata. Both the SDK modules and bundled CLI/RPC entrypoints are rebuilt from the patched source. Refresh the pi-stack lockfile after replacing the tarball.

To adopt another upstream commit, build and pack both workspaces from that commit, carry forward the session-thinking behavior and tests, and update the provenance and lockfile together. Return to npm registry packages when a published release contains both Astra support and the session-thinking behavior. Delete the replaced tarballs and source patch then.

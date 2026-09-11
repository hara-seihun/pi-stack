# Pi source packages

These tarballs carry Pi upstream commit `17de82d7bea18a6589677a9761baabc2060c9efb`, the first commit with GPT-6 Astra support. Upstream had not published that commit when we adopted it, so the ordinary npm registry could not reproduce the requested runtime.

`pi-ai` is built from that commit. `pi-coding-agent` includes two source patches, each with regression tests:

- [session-thinking.patch](session-thinking.patch) makes thinking defaults apply only when a session has no saved or explicitly supplied level. Model selection and account routing preserve the session level. Explicit thinking changes, explicit scoped-model levels, and model capability clamping still apply.
- [extension-releases.patch](extension-releases.patch) resolves extension entrypoints to physical paths before importing or caching their factories. Node's native ESM cache otherwise retains the first target of a deployment symlink even after Pi clears its own extension cache. Reload and session replacement now select the current release, including on rollback. The resource loader uses the same physical identity when carrying extensions through project-trust resolution. Comparing physical preload keys with symlink lookup keys silently discarded every symlinked extension's handlers during CLI startup. Provider registrations survived, but account routing, tools and context observers did not.

Deployment additionally applies the [Codex SSE framing and tool-tail cut repairs](../../packages/runtime/README.md#codex-transport-framing) to the SDK and bundled copies in the immutable dependency tree. These fix the LF-only parser and an all-history retention bug found during native compaction integration. These deployment transforms do not alter the checked-in tarballs.

Both package versions remain `0.85.0`; their filenames alone are not provenance. This file, the source patch, and the tarball hashes in `package-lock.json` identify what we ship. Pi 0.85's CLI imports `@earendil-works/pi-server`, but its coding-agent manifest omits that dependency, so the root manifest pins the matching published server package explicitly.

## Rebuild the coding agent

Take a clean upstream checkout at the commit above. Set `stack` to the absolute path of this pi-stack checkout, then run these commands from the upstream checkout:

```sh
git apply "$stack/vendor/pi/session-thinking.patch" "$stack/vendor/pi/extension-releases.patch"
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p packages/ai/src/providers
tar -xzf "$stack/vendor/pi/earendil-works-pi-ai-0.85.0-17de82d7bea1.tgz" \
  --strip-components=3 -C packages/ai/src/providers package/dist/providers/data
npm run build:offline
npm pack --ignore-scripts --workspace=@earendil-works/pi-coding-agent --pack-destination "$stack/vendor/pi"
mv "$stack/vendor/pi/earendil-works-pi-coding-agent-0.85.0.tgz" \
  "$stack/vendor/pi/earendil-works-pi-coding-agent-0.85.0-runtime.tgz"
```

The model data comes from the shipped Pi AI tarball rather than live catalogs, so rebuilding the agent does not silently change model metadata. Both the SDK modules and bundled CLI/RPC entrypoints are rebuilt from the patched source. Refresh the pi-stack lockfile after replacing the tarball.

To adopt another upstream commit, build and pack both workspaces from that commit, carry forward both patches' behavior and tests, and update the provenance and lockfile together. Return to npm registry packages when a published release contains Astra support and both fixes. Delete the replaced tarballs and source patches then.

# Pi source packages

These tarballs carry Pi 0.87.1, upstream commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`. The published `pi-ai` package includes GPT-6 Sol and GPT-6 Luna for OpenAI API keys, OpenAI Codex subscriptions, Azure OpenAI Responses, GitHub Copilot, OpenCode, Radius, OpenRouter, and Vercel AI Gateway. It also retains GPT-5.6 Sol and GPT-5.6 Luna. Pi Stack filters Terra from the catalog at its routing boundary.

`pi-ai` is the unmodified registry package. `pi-coding-agent` is rebuilt from the same commit with two source patches and their regression tests:

- [session-thinking.patch](session-thinking.patch) makes thinking defaults apply only when a session has no saved or explicitly supplied level. Model selection and account routing preserve the session level. Explicit thinking changes, explicit scoped-model levels, and model capability clamping still apply.
- [extension-releases.patch](extension-releases.patch) resolves extension entrypoints to physical paths before importing or caching their factories. Node's native ESM cache otherwise retains the first target of a deployment symlink even after Pi clears its own extension cache. Reload and session replacement select the current release, including on rollback. The resource loader uses the same physical identity when carrying extensions through project-trust resolution.

Both patches still apply cleanly to 0.87.1 and remain necessary. Deployment additionally applies the [Codex transport, compaction failure, session durability, shared custody, and shared RPC repairs](../../packages/runtime/README.md) to the SDK and bundled runtime copies in the immutable dependency tree. Pi 0.87.1 now owns the trailing-tool compaction cut repair that Pi Stack previously applied at deployment.

The tarball hashes in `package-lock.json`, this provenance, and the source patches identify what the stack ships.

## Rebuild the coding agent

Take a clean upstream checkout at commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`. Set `stack` to the absolute path of this pi-stack checkout, then run:

```sh
git apply "$stack/vendor/pi/session-thinking.patch" "$stack/vendor/pi/extension-releases.patch"
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p packages/ai/src/providers
tar -xzf "$stack/vendor/pi/earendil-works-pi-ai-0.87.1.tgz" \
  --strip-components=3 -C packages/ai/src/providers package/dist/providers/data
npm run build:offline
npm pack --ignore-scripts --workspace=@earendil-works/pi-coding-agent --pack-destination "$stack/vendor/pi"
mv "$stack/vendor/pi/earendil-works-pi-coding-agent-0.87.1.tgz" \
  "$stack/vendor/pi/earendil-works-pi-coding-agent-0.87.1-runtime.tgz"
```

The model data comes from the shipped Pi AI tarball rather than a live catalog, so rebuilding the agent does not change model metadata. Both the SDK modules and bundled CLI/RPC entrypoints are rebuilt from patched source. Refresh the pi-stack lockfile after replacing either tarball.

To adopt another upstream release, build both workspaces from its commit, carry forward both source-patch behaviors and tests, update the runtime deployment transforms, and update provenance and lockfile together. Return to the registry coding-agent package when an upstream release contains both source fixes.

# Write's local rewrite runtime

`deploy/write-rewrite-runtime STORE` installs the pinned CPU-only llama.cpp server
and GGUF weights as public, root-owned entries. `deploy/write-engine` invokes it
before preparing an engine and links the entries as `rewrite-runtime` and
`rewrite-model`. The engine owns its server subprocess; this installer creates no
service, changes no running service and sends no dictation to a remote API.

- Runtime executable: `rewrite-runtime/llama-server`; the wrapper resolves its
  real path and selects only the packaged shared-library directory.
- Weights: `rewrite-model/model.gguf`.
- Source pins, URLs, sizes, hashes and license provenance: `runtime.json` and
  `model.json`. The runtime includes upstream's MIT/dependency licenses; the model
  includes its vendored Apache-2.0 `LICENSE` and attribution/quantization `NOTICE`.
- Ubuntu 26.04 kenan-server and Debian 12 converge-kenan use the same upstream
  Ubuntu 22.04 x64 CPU archive. The installer rejects non-x86_64 Linux, non-glibc,
  glibc older than 2.34 and CPUs without the pinned required flags. Missing native
  dependencies fail the executable's bounded `--version` probe. No Nix interpreter,
  exploratory checkout, user Python cache or managed GPU dependency is involved.
  b5377's server `--version` passed on both hosts; no service was restarted.

The public store normally lives at `/srv/pi/.pi-write`. Runtime entries are keyed
by manifest and installer implementation; model entries by manifest. Engine
preparation hashes both manifests and installer inputs, and retains the selected
and previous engine's linked entries. Verified artifacts are reused across keys;
`PI_STACK_WRITE_REWRITE_CACHE=/absolute/directory` can seed preparation with a
previously downloaded artifact (its name is immaterial; size/hash must match).
By default the seed directory is `/srv/pi/write-rewrite-cache`, outside engine
retention. It contains only root-owned public model/runtime downloads, no state or
credentials. This avoids unrelated releases removing prepared-but-unselected
assets and forcing the same large download again. Missing seeds are downloaded
into the component store; the cache is optional and safe to remove/rebuild.
Standalone installation is not selection or a retention pin; `deploy/write-engine`
creates the dependency links for a complete prepared engine.
Copies become root-owned public files, never links into that cache. With no seed,
only public HTTPS artifacts are downloaded. Deployment's 50-second outer deadline
bounds resumable downloads; `.part` files survive an interrupted preparation.
Run preparation again to resume rather than selecting an incomplete engine.

`deploy/write-rewrite-runtime --paths STORE` prints the two immutable entry paths;
`--check STORE` validates runtime files, executable wrapper and full model digest
without installing or downloading. A ready marker alone is not accepted. Archive
extraction rejects traversal, links, special files and duplicate members, and
extracts only the manifest's flat file allowlist.

Seconds-only fixture checks:

```sh
python3 -m unittest discover -s apps/write/rewrite-runtime -p 'test_*.py'
```

The fixtures cover checksum reuse, corruption repair, input-key invalidation,
public permissions, path/link rejection and incompatible glibc rejection. Runtime
lifecycle, inference parameters and rewrite behavior belong to the engine.

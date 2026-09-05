# Pi source packages

These tarballs carry Pi upstream commit `17de82d7bea18a6589677a9761baabc2060c9efb`, the first commit with GPT-6 Astra support. Upstream had not published that commit when we adopted it, so the ordinary npm registry could not reproduce the requested runtime.

The tarballs contain `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` built from one clean checkout of that commit. Their package version remains upstream's `0.85.0`; the filenames alone are not provenance. This file and the tarball hashes in `package-lock.json` identify what we ship. Pi 0.85's CLI imports `@earendil-works/pi-server`, but its coding-agent manifest omits that dependency, so the root manifest pins the matching published server package explicitly.

To replace them from another upstream commit, take a clean checkout at that commit and run the root `npm ci --ignore-scripts` and `npm run build`. Pack both workspaces with `npm pack --ignore-scripts --workspace=<package> --pack-destination <this-directory>`, regenerate the pi-stack lockfile, and update this provenance in the same commit.

Delete these tarballs and return the dependencies to npm registry versions once a published Pi release contains the same changes. Do not keep the source packages beside that release as a second installation path.

const NATIVE_COMMAND = "npm run android:test --workspace=kenan";
const IDENTITY_KEYS = ["revision", "versionCode", "applicationId", "shellId"];

function nativeProof(request) {
  if (Object.hasOwn(request, "nativeChecks")) {
    const proof = request.nativeChecks;
    return proof?.status === "passed" && proof.command === NATIVE_COMMAND
      && proof.revision === request.integrationSha && proof.identity?.revision === proof.revision
      && typeof proof.at === "string" && Number.isFinite(Date.parse(proof.at)) ? proof : null;
  }
  const checks = request.checks;
  if (checks?.status !== "passed" || checks.command !== `npm run check && ${NATIVE_COMMAND}`
    || !checks.androidPlan || checks.androidPlan.kind !== "native"
    || checks.androidPlan.identity?.revision !== request.integrationSha
    || typeof checks.at !== "string" || !Number.isFinite(Date.parse(checks.at))) return null;
  return { status: "passed", revision: request.integrationSha, identity: checks.androidPlan.identity, command: NATIVE_COMMAND, at: checks.at };
}

// Activation is not native evidence: a checked, prepared APK is reusable even if its host release failed.
export function checkedPreparedNative(request, identity, { readArtifact, git }) {
  const proof = nativeProof(request);
  if (!proof) return { ok: false, reason: "native-checks-unproven" };
  if (typeof request.requestId !== "string" || !request.requestId) return { ok: false, reason: "native-proof-mismatch" };
  const android = request.android;
  if (!android || typeof android.directory !== "string" || !android.directory
    || android.release?.revision !== proof.revision
    || IDENTITY_KEYS.some(key => android.release[key] !== proof.identity[key])) return { ok: false, reason: "native-proof-mismatch" };
  const release = android.release;
  if (release.applicationId !== identity.applicationId || release.shellId !== identity.shellId) return { ok: false, reason: "shell-inputs-changed" };
  if (identity.versionCode < release.versionCode || identity.versionCode === release.versionCode && identity.revision !== release.revision) {
    return { ok: false, reason: "version-conflict" };
  }
  try { git("merge-base", "--is-ancestor", release.revision, identity.revision); }
  catch { return { ok: false, reason: "not-ancestor" }; }
  let changedTests;
  try { changedTests = git("diff", "--name-only", proof.revision, identity.revision, "--", "apps/kenan/android/app/src/test"); }
  catch { return { ok: false, reason: "source-unavailable" }; }
  if (changedTests) return { ok: false, reason: "native-tests-changed" };
  let prepared;
  try { prepared = readArtifact(android.directory); }
  catch { return { ok: false, reason: "artifact-invalid" }; }
  if (Object.keys(release).some(key => prepared.release[key] !== release[key])) return { ok: false, reason: "artifact-proof-mismatch" };
  return { ok: true, value: { nativeDirectory: android.directory, release: prepared.release,
    nativeProof: { requestId: request.requestId, revision: proof.revision, command: proof.command, at: proof.at } } };
}

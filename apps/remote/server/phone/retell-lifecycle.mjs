// Retell 3.0.2's monitor stream distinguishes AI-leg replacement from telephone
// termination, but its gateway data channel bypasses that same lifecycle owner.
export function repairRetellLifecycle(source) {
  const before = 'if (event.state === "ended" || event.state === "replaced") this.finish({});';
  const after = 'if (event.state === "ended" || event.state === "replaced") this.monitorEnded(event);';
  if (source.split(before).length !== 2) throw new Error('Unsupported Retell gateway lifecycle source');
  return source.replace(before, after);
}

/** Narrow runner control-protocol refusals: no session was admitted.
 * Transport serializes errors, so recognize only the owner's exact messages.
 * Do not treat configuration, uncertain startup ownership or provider failures as capacity. */
export function isRunnerCapacityFailure(message: string): boolean {
  return /^(?:Error: )*Runner capacity busy(?:: memory pressure|; work remains queued)$/.test(message);
}

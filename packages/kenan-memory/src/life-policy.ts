import type { LifePolicyInput } from "./life-contract.js";

export function conservativeLifePolicy(person: string, at: string): LifePolicyInput {
  return {
    status: "active", domains: [],
    delegation: "No expanded standing delegation is established. Carry out direct instructions within existing tool permissions; ask before consequential actions not directly requested.",
    financialDiscretion: null, steering: { mode: "off", instruction: null }, exclusions: [],
    disclosure: "Keep private life information in this person's boundary. Cross-person disclosure belongs to the authenticated root boundary.",
    consent: { thirdParty: "Respect every other person's consent and ownership.", immediateOverride: null },
    protectedSkills: [], reviewAt: null,
    provenance: { factClass: "derived", confidence: null, source: { actor: "system", locator: `life:initial-policy:${person}`, observedAt: at }, evidence: [], counterevidence: [], validFrom: at, validUntil: null },
  };
}

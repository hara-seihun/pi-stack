import { createCwdAdmission, type CwdAdmission } from "../workspace-admission.js";

export function piCwdAdmission(configuration: string | undefined): CwdAdmission {
  const result = createCwdAdmission(configuration);
  if (!result.ok) throw new Error(`Pi cwd admission: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function requirePiCwd(admission: CwdAdmission, cwd: unknown, field: string): string {
  const result = admission.resolveCwd(cwd);
  if (!result.ok) throw new Error(`Pi cwd admission rejected ${field}: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

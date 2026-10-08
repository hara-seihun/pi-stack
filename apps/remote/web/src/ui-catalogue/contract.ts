import type { ReactNode } from "react";

export type UiFixtureActionResult = { ok: true } | { ok: false; code: "unknown-case" | "unknown-action" | "not-mounted"; error: string };

export type UiCase = {
  id: string;
  title: string;
  component: string;
  contract: string;
  boundary: "finite-variant" | "content-boundary" | "composition";
  render(): ReactNode;
  actions?: ReadonlyArray<{ id: string; label: string; run(): UiFixtureActionResult }>;
};

export type UiReview = {
  caseId: string;
  viewport: "phone" | "tablet" | "desktop";
  theme: "light" | "dark";
  status: "passed" | "fixed" | "needs-fix";
  evidence: string;
  additionalEvidence?: string[];
  judgment: string;
};

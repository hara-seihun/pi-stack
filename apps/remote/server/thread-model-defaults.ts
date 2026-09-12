export interface ThreadDestination {
  id: string;
  label: string;
  icon: string;
  accent: string;
  workspaceId: string;
  thinkingLevel: string;
  models: string[];
  defaultModel: string;
  core?: "pi" | "codex";
}

export function defaultThreadDestinations(personalWorkspaceId?: string): ThreadDestination[] {
  const destinations = [
    ...(personalWorkspaceId === undefined ? [] : [
      { id: "personal", label: "PERSONAL", icon: "personal", accent: "#a371f7", workspaceId: personalWorkspaceId },
    ]),
    { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home" },
  ];
  return destinations.map(destination => ({
    ...destination,
    thinkingLevel: "high",
    models: ["astra", "sol", "terra", "luna", "fable", "opus"],
    defaultModel: "astra",
  }));
}

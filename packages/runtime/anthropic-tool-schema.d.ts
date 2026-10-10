export function anthropicToolSchema<T extends object>(parameters: T): T & { type: "object" };

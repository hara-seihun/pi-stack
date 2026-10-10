function requiresObject(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (schema.type === "object") return true;
  if (schema.type !== undefined && !(Array.isArray(schema.type) && schema.type.includes("object"))) return false;
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0 && branches.every(requiresObject)) return true;
  }
  return Array.isArray(schema.allOf) && schema.allOf.some(requiresObject);
}

export function anthropicToolSchema(parameters) {
  if (!requiresObject(parameters)) throw new Error("Anthropic tool parameters must describe an object");
  // Anthropic requires a root object type; object unions already imply it.
  // Keep every branch and constraint instead of projecting only root properties.
  return parameters.type === "object" ? parameters : { ...parameters, type: "object" };
}

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

function parameterFields(schema, fields) {
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const variants = fields[name] ??= [];
    if (!variants.some(variant => JSON.stringify(variant) === JSON.stringify(property))) variants.push(property);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    for (const branch of schema[keyword] ?? []) parameterFields(branch, fields);
  }
}

export function anthropicToolSchema(parameters) {
  if (!requiresObject(parameters)) throw new Error("Anthropic tool parameters must describe an object");
  if (!["anyOf", "oneOf", "allOf"].some(keyword => Object.hasOwn(parameters, keyword))) {
    return parameters.type === "object" ? parameters : { ...parameters, type: "object" };
  }
  const fields = Object.create(null);
  parameterFields(parameters, fields);
  const properties = Object.fromEntries(Object.entries(fields).map(([name, variants]) => [
    name, variants.length === 1 ? variants[0] : { anyOf: variants },
  ]));
  // Root properties carry the real types used by the provider's argument encoder.
  // Operation-specific requirements and exclusions remain in the nested contract.
  const wire = { type: "object", properties, not: { not: parameters } };
  for (const keyword of ["$defs", "definitions", "$id", "$schema", "title", "description"]) {
    if (Object.hasOwn(parameters, keyword)) wire[keyword] = parameters[keyword];
  }
  return wire;
}

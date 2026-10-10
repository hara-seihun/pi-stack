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
    if (!Object.hasOwn(fields, name)) fields[name] = property.description === undefined ? {} : { description: property.description };
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
  const properties = {};
  parameterFields(parameters, properties);
  // Anthropic forbids root combinators. Double negation moves the unchanged
  // contract below the root without weakening closed or permissive branches.
  const wire = { type: "object", properties, not: { not: parameters } };
  for (const keyword of ["$defs", "definitions", "$id", "$schema", "title", "description"]) {
    if (Object.hasOwn(parameters, keyword)) wire[keyword] = parameters[keyword];
  }
  return wire;
}

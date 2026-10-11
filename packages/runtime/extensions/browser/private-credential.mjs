const fields = ["username", "email", "password", "totp", "cardholder_name", "number", "verification_number", "expiration_date", "passport_number", "phone_number"];
const modes = ["args", "semanticAction", "script", "job", "qa", "electron", "sourceLookup", "networkSourceLookup"];
const required = ["provider", "item", "field", "selector", "target", "frame"];
const nonempty = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const failure = () => ({
  isError: true,
  content: [{ type: "text", text: "Private credential fill requires one privateCredential mode with explicit provider, item, field, selector, target and frame; no plaintext, stdin, fresh launch or conflicting mode. format mm/yy is only valid for expiration_date." }],
  details: { resultCategory: "failure", failureCategory: "validation-error", code: "private_credential_invalid" },
});

export const privateCredentialSchema = {
  type: "object", additionalProperties: false, required,
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 128, description: "Configured credential plugin name, such as proton-pass." },
    item: { type: "string", minLength: 1, maxLength: 256, description: "Exact vault item reference; never the secret value." },
    field: { type: "string", enum: fields },
    selector: { type: "string", minLength: 1, maxLength: 4096, description: "Selected frame's CSS selector or current @ref." },
    target: { type: "string", minLength: 1, maxLength: 256, description: "Exact active CDP targetId from tab list." },
    frame: { type: "string", minLength: 1, maxLength: 256, description: "Exact selected frameId, or main for the top-level frame." },
    format: { type: "string", enum: ["raw", "mm/yy"] },
  },
};

export function compilePrivateCredential(params) {
  const credential = params.privateCredential;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)
      || Object.keys(credential).some(key => ![...required, "format"].includes(key))
      || !required.every(key => nonempty(credential[key], key === "selector" ? 4096 : key === "provider" ? 128 : 256))
      || !fields.includes(credential.field)
      || credential.format !== undefined && !["raw", "mm/yy"].includes(credential.format)
      || credential.format === "mm/yy" && credential.field !== "expiration_date"
      || modes.some(key => params[key] !== undefined) || params.stdin !== undefined || params.sessionMode === "fresh") return { ok: false };
  const args = ["auth", "fill", "--credential-provider", credential.provider, "--item", credential.item,
    "--field", credential.field, "--selector", credential.selector, "--target", credential.target, "--frame", credential.frame];
  if (credential.format !== undefined) args.push("--format", credential.format);
  const { privateCredential: _credential, ...input } = params;
  return { ok: true, input: { ...input, args } };
}

export function installPrivateCredentialMode(tool) {
  const execute = tool.execute.bind(tool);
  tool.parameters = { ...tool.parameters, properties: { ...tool.parameters.properties, privateCredential: privateCredentialSchema } };
  tool.description += " privateCredential fills one selected field from a configured credential plugin without exposing its value in tool arguments/output. Requires provider,item,field,selector,target,frame; use frameId or main. Select the tab/frame first; card entry requires an authorized purchase. This fills only, never submits. Declared externalAction still crosses the canonical fence.";
  tool.execute = function (toolCallId, params, signal, onUpdate, ctx) {
    if (!params || typeof params !== "object" || params.privateCredential === undefined) return execute(toolCallId, params, signal, onUpdate, ctx);
    const compiled = compilePrivateCredential(params);
    return compiled.ok ? execute(toolCallId, compiled.input, signal, onUpdate, ctx) : failure();
  };
}

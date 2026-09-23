import { access, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.js";
import type { SharedOAuthAuth } from "../auth/shared-oauth.js";
import { chooseInteractiveAccount } from "../auth/account-selection.js";
import { IMAGE_MODELS, IMAGE_QUALITIES, IMAGE_SIZES, requestImage, type ImageResult } from "../image-generation.js";
import { createSharedImageGenerationService, imageAuth, imagePath, loadImageInputs, type SharedImageResult } from "../image-service.js";

const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 32000, description: "Image description or editing instructions." }),
  outputPath: Type.String({ minLength: 1, description: "New PNG file path for the final image, absolute or relative to the working directory. Additional provider images are saved as NAME.image-N.png. Existing files are not overwritten." }),
  model: Type.Optional(StringEnum(IMAGE_MODELS, { description: "Defaults to Image 2.5 Flare. Sunburst specializes in precise editing." })),
  quality: Type.Optional(StringEnum(IMAGE_QUALITIES)),
  size: Type.Optional(StringEnum(IMAGE_SIZES)),
  inputPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16, description: "Local PNG, JPEG or WebP images to edit. Maximum combined input size is 32 MiB." })),
});
export type ImageToolInput = Static<typeof parameters>;
type Connection = { kind: "shared" } | { kind: "personal"; provider: "openai-codex" | "openai" };

export function installImageGeneration(pi: ExtensionAPI, store: Store, shared: SharedOAuthAuth | undefined, brokerUrl?: string) {
  const service = createSharedImageGenerationService(brokerUrl ? { brokerUrl } : { store, shared });
  pi.on("session_shutdown", () => service.close());
  const connection = (ctx: ExtensionContext): Connection | undefined => {
    if (brokerUrl) return { kind: "shared" };
    const account = chooseInteractiveAccount(store, shared, "openai-codex");
    if (account) return { kind: "shared" };
    for (const provider of ["openai-codex", "openai"] as const) {
      if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) return { kind: "personal", provider };
    }
    return undefined;
  };
  const generate = async (params: ImageToolInput, ctx: ExtensionContext, signal: AbortSignal): Promise<SharedImageResult | ImageResult> => {
    const selected = connection(ctx);
    if (!selected || selected.kind === "shared") return service.generateImageWithSharedAccount(params, { cwd: ctx.cwd, signal });
    try {
      const credential = (await ctx.modelRegistry.getProviderAuth(selected.provider))?.auth;
      const auth = imageAuth(credential, selected.provider === "openai-codex" ? "codex" : "api");
      if (!auth.ok) return auth;
      const inputs = await loadImageInputs(params, ctx.cwd, signal);
      if (!inputs.ok) return inputs;
      return requestImage({ ...params, images: inputs.value }, auth.value, signal);
    } catch (error) {
      return { ok: false, error: { kind: "authentication", message: `OpenAI authentication failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  };
  let registered = false;
  let disabledForAccount = false;
  const reconcile = (_event: unknown, ctx: ExtensionContext) => {
    const available = !!connection(ctx);
    if (available && !registered) {
      registered = true;
      pi.registerTool({
        name: "image_generation", label: "Generate image", parameters,
        description: "Generate or edit an image using OpenAI Image 2.5. Saves every completed image and returns the final image preview and all absolute paths. Requires a connected OpenAI account; works regardless of the current chat model. Requests have a five-minute deadline and are never automatically retried.",
        async execute(_id, params, signal, onUpdate, ctx) {
          const path = imagePath(params.outputPath, ctx.cwd);
          if (extname(path).toLowerCase() !== ".png") throw new Error("outputPath must end in .png");
          if (!params.prompt.trim()) throw new Error("Image prompt cannot be blank");
          const requestSignal = AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
          return withFileMutationQueue(path, async () => {
            requestSignal.throwIfAborted();
            await mkdir(dirname(path), { recursive: true });
            try { await access(path); throw new Error(`Image output already exists: ${path}`); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            const staging = await mkdtemp(`${path}.staging-`);
            let preserve = false;
            try {
              onUpdate?.({ content: [{ type: "text", text: `Generating with ${params.model ?? IMAGE_MODELS[0]}…` }], details: {} });
              const result = await generate(params, ctx, requestSignal);
              if (!result.ok) throw new Error(result.error.message);
              const { images, model, responseId, usage } = result;
              const outputs = images.map((image, index) => ({
                id: image.id,
                path: index === images.length - 1 ? path : `${path.slice(0, -4)}.image-${index + 1}.png`,
                staging: join(staging, `${index + 1}.png`),
              }));
              preserve = true;
              try {
                await writeFile(join(staging, "receipt.json"), JSON.stringify({ responseId, model, providerUsage: usage, outputs }), { flag: "wx", mode: 0o600 });
                for (let index = 0; index < images.length; index++) {
                  await writeFile(outputs[index].staging, images[index].bytes, { flag: "wx", mode: 0o600 });
                }
                for (const output of outputs) await link(output.staging, output.path);
              } catch (error) {
                throw new Error(`Image output retained at ${staging}; response ${responseId}. Publication failed: ${error instanceof Error ? error.message : String(error)}. No automatic retry was made.`);
              }
              preserve = false;
              return {
                content: [
                  { type: "text" as const, text: `Saved ${path}\nAll images:\n${outputs.map(output => output.path).join("\n")}\nModel: ${model}\nResponse: ${responseId}` },
                  { type: "image" as const, mimeType: "image/png", data: images[images.length - 1].bytes.toString("base64") },
                ],
                details: { path, paths: outputs.map(output => output.path), images: outputs.map(({ id, path }) => ({ id, path })), model, responseId, providerUsage: usage },
              };
            } finally { if (!preserve) await rm(staging, { recursive: true }); }
          });
        },
      });
    }
    if (!registered) return;
    const active = pi.getActiveTools();
    if (!available && active.includes("image_generation")) {
      disabledForAccount = true;
      pi.setActiveTools(active.filter(name => name !== "image_generation"));
    } else if (available && disabledForAccount) {
      disabledForAccount = false;
      pi.setActiveTools([...active, "image_generation"]);
    }
  };
  pi.on("session_start", reconcile);
  pi.on("before_agent_start", reconcile);
}

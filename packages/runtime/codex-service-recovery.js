const codexPreOutputServiceFailures = new WeakMap();

async function* mapCodexEvents(events, output) {
  let beforeOutput = true;
  async function* inspected() {
    for await (const event of events) {
      if (!["response.created", "response.queued", "response.in_progress", "response.failed", "error"].includes(event.type)) beforeOutput = false;
      if (event.response?.output?.length || ["total_tokens", "input_tokens", "output_tokens"].some(key => event.response?.usage?.[key] > 0)) beforeOutput = false;
      yield event;
    }
  }
  try {
    yield* mapCodexEventsAttempt(inspected(), output);
  } catch (error) {
    const payload = error instanceof CodexApiError ? error.payload : undefined;
    const failure = payload?.type === "response.failed" ? payload.response?.error : payload?.type === "error" ? payload.error ?? payload : undefined;
    const reason = failure?.message === "no_biscuit_no_service" || failure?.code === "no_biscuit_no_service"
      ? "no_biscuit_no_service"
      : failure?.message === "The access_programs parameter is not enabled for this organization." &&
        (!failure.code || ["server_error", "invalid_request_error"].includes(failure.code))
        ? "access_programs_not_enabled" : undefined;
    if (beforeOutput && output.content.length === 0 && output.usage.totalTokens === 0 && reason) {
      codexPreOutputServiceFailures.set(output, { reason, responseId: payload.response?.id ?? output.responseId, code: failure.code });
    }
    throw error;
  }
}

function streamWithCodexServiceRecovery(model, context, options) {
  const result = new AssistantMessageEventStream();
  (async () => {
    let diagnostic;
    let payload;
    const retryOptions = { ...options, onPayload: async (body, requestModel) => {
      if (payload === undefined) payload = structuredClone(await options?.onPayload?.(body, requestModel) ?? body);
      return structuredClone(payload);
    } };
    for (let attempt = 0; attempt < 2; attempt++) {
      let start;
      let emitted = false;
      for await (const event of streamAttempt(model, context, retryOptions)) {
        if (event.type === "start") { start = event; continue; }
        const failure = event.type === "error" ? codexPreOutputServiceFailures.get(event.error) : undefined;
        const retryable = failure && (failure.reason !== "access_programs_not_enabled" || !Object.hasOwn(payload, "access_programs"));
        if (event.type === "error" && attempt === 0 && !emitted && !options?.signal?.aborted && retryable) {
          diagnostic = createAssistantMessageDiagnostic("provider_service_retry", new Error(event.error.errorMessage), {
            ...failure,
            provider: model.provider,
            model: model.id,
            attempt: 1,
            nextAttempt: 2,
            phase: "before_output",
          });
          break;
        }
        if (start) { result.push(start); start = undefined; }
        emitted = true;
        if (event.type === "done" || event.type === "error") {
          if (diagnostic) appendAssistantMessageDiagnostic(event.type === "done" ? event.message : event.error, diagnostic);
          result.push(event);
          result.end();
          return;
        }
        result.push(event);
      }
    }
  })();
  return result;
}

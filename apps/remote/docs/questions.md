# Asynchronous questions

A thread can ask for decisions without pausing its work. The `request_user_input_async` tool accepts a nonempty `questions` array, stores all its questions atomically with the thread owner and immediately returns `{accepted: true, questionIds}` in input order. Put each independently answerable question in its own item, rather than combining several questions into one prompt or suggestion list. Use a one-item array for a single question. Each answer arrives later as a correlated human message through ordinary thread delivery, at a safe tool boundary without cancelling the running work.

```json
{
  "questions": [
    {
      "question": "Which environments should receive the change?",
      "suggestions": ["Staging", "Production", "Development"],
      "recommendedSuggestionIndex": 0
    },
    {
      "question": "When should the change go live?",
      "suggestions": ["Now", "Tomorrow"],
      "recommendedSuggestionIndex": 1
    }
  ]
}
```

Each item has its own optional `suggestions` with no fixed count. Its optional `recommendedSuggestionIndex` identifies one of that item's suggestions, using a zero-based index. Recommendation is presentation, not a selection or authorization. An invalid item rejects the entire batch without leaving partial questions. Retrying the same tool call returns the same ordered IDs, including questions already answered.

## Authoring

Renia-reduce every ask-user question, including personal and room `request_user_input_async` calls, watch checks and root-routed permission requests:

- Ask the decision or person-only fact first.
- Retain only context that could change the person's answer. Cut process narration, repeated status and details they will not use.
- Preserve material uncertainty, consequences, scope and deadlines when they affect the choice. Do not shorten away a distinction that changes the answer.
- Keep suggestions concise and independently meaningful; do not bundle separate decisions into one choice.
- Questions and suggestions may use Markdown for readable structure, emphasis and links.

The author supplies the final text. Storage and routing preserve that text and its Markdown without automatic lossy truncation or an additional model rewrite. Invalid input is rejected, not shortened into an accepted question. Root consent adds authenticated requester/audience and private-return/non-authorization context after the authored question, so the actual decision stays first.

The shared [question authoring policy](../../../packages/orchestrator/src/threads/question-policy.ts) supplies the ordinary tool, watch prompt and root consent tool contract. [Root instructions](../../../packages/kenan-root/instructions.md) apply the same rule to permission requests.

For example:

```json
{
  "questions": [{
    "question": "**Publish to production now?**\n\nThis restarts the service. Staging passed; production migration time is still unknown.",
    "suggestions": ["Publish now", "Keep staging only"],
    "recommendedSuggestionIndex": 1
  }]
}
```

## Answering

Pending questions replace the normal message composer in an AI conversation. The next question appears directly below the transcript, with a quiet remaining count, formatted answer choices, a free-text answer and **Dismiss question**. Personal and room composers share the same question presentation: Markdown paragraphs, emphasis, lists, links, tables and code render in both the question and suggested answers. Choices appear before the free-text field; the recommendation is a separate quiet label. Attention cards and question history use the same rich text, with a separate original-conversation link so Markdown links remain usable. Answer or dismiss each question in creation order before ordinary messaging returns. The unsent message, attachments and reply draft are preserved. Answering one does not consume the other questions in its batch. **Cancel work** remains available in the header while the agent is running.

- Select any number of suggestions, including none.
- Add text whether or not suggestions are selected.
- A recommendation is labelled; nothing is selected or submitted automatically.
- The only empty-answer error is no selected suggestions and no non-whitespace text.
- Switching conversations does not submit an answer. Failed submissions retain the answer draft for retry.
- **Dismiss question** durably settles that question without selecting or authorizing a suggestion. The agent receives a correlated human steer beginning `Dismissed question QUESTION_ID: PROMPT`, explicitly saying the user skipped it. Dismissal retries are idempotent; an accepted dismissal cannot later be replaced with an answer.

On phones the question composer never takes more than 60dvh; its body scrolls internally while dismissal and submission stay outside the scrolling body. Suggested answers and dismissal have at least 48px tap targets. Short questions keep the answer field visible when it fits; long text, tables and code scroll without widening the page. Formatting is presentation only: question text, suggestion IDs and durable answer semantics are unchanged. Raw HTML stays literal and question rendering never resolves private session-file/image tags. The answer field uses the same phone newline behavior as ordinary messages.

Questions survive the agent's turn ending and owner restarts. Answering removes a question from the pending list only after durable acceptance. Repeated delivery of the same answer does not send another message. Questions remain associated with their original thread, including when accessed through an authorized peer owner; an account cannot answer another person's private thread.

## Transport and custody

The owning thread database stores questions and answer receipts. Remote is a client of that owner, not another question store. For ordinary async questions, the model's original tool call and the eventual human answer remain in native Pi history.

Root permission questions in a marked `rootConsent` inbox are owned by the existing `consent:ID:question` ask receipt. Their answers stay in the owner's durable question record and are projected as visible, correlated user receipts in history reads and the Remote transcript. They are not ordinary Pi work and do not start or steer the subject's agent; RootConsentManager reads the receipt and owns continuation. Dismissal grants nothing. The answer does not unhold unrelated work or restore an archived inbox. Subsequent ordinary inbox conversation and its own async questions still use normal delivery.

- `GET /v1/sessions/:sessionId/questions` returns `{questions}` with pending questions.
- `POST /v1/sessions/:sessionId/questions/:questionId/answer` accepts `{selectedSuggestionIds, text}` or `{selectedSuggestionIds: [], text: "", dismissed: true}` and returns `{accepted: true, questionId}`.
- The selected conversation's shared resource stream publishes `{type: "questions", sessionId, state, questions}`. `state` is `loading`, `ready`, or `failed`; failure also carries `error`. Loading and failure retain the last known questions explicitly as stale. A ready snapshot replaces those questions and clears only this resource's error. Questions never mark the whole chat offline or delay finite transcript/readiness synchronization. **Retry questions** reloads this resource, not the chat connection.
- Known local and peer sessions read questions directly from their owning service. Directory discovery is used only when the owner is not yet known.

A question contains `id`, `threadId`, `question`, `suggestions: [{id, text}]`, optional `recommendedSuggestionId`, and `createdAt`. Suggestions have stable identities so the answer preserves exactly which choices the user selected, alongside their free-form text.

## Notifications

Asking records durable, ordered question occurrences atomically with the questions and their ask receipt. `ThreadApi.questionEvents(after, limit)` pages this owner-local feed; accepted questions are suppressed but still advance the cursor. Remote projects it into the existing `/v1/notifications` and stream feed, with `kind: "question"` and `body` containing the prompt, using a separate durable cursor per thread owner. Projection retries do not duplicate notices. Pending questions recovered from before this feed was introduced are seeded once.

Browser and Android use their existing notification permission and delivery channel. Another thread's question shows a clickable foreground toast, or a private system notification while backgrounded; the visible thread is suppressed because its card is already up. Android polls every permitted environment every 30 seconds in the background and consumes the selected environment's stream immediately in the foreground. Tapping opens that person/environment/thread with the question composer visible. Background-agent questions notify too. Ordinary completion notices follow foreground placement. A completion while questions remain pending does not overwrite the question alert with an idle notice.

The persistent **Notifications** tab retains attention and question records after a toast or native alert disappears. **Needs you** resolves each question receipt against its original owner's pending questions; answered or dismissed questions move to **History**. An unavailable owner preserves the record with a status error. Opening a record opens/promotes the original agent under Chats without restarting cancelled work. `GET /v1/notifications?history=1&before=N` pages the existing durable ledger independently of notification replay cursors; see [state and presentation](state-machine.md#notifications).

The unified UI uses the same native notification payload and channel, so these UI changes can ship as a shared web-bundle update. No separate question channel or push credentials are required.

The design follows Codex CLI's immediate acknowledgement/new-user-message contract, inspected at upstream commit `e07e58c8429019de78b138d7138deaaf7f3ef22c`. Pi Stack deliberately differs by retaining pending questions beyond a turn, allowing multiple selections together with text, and marking a recommendation explicitly rather than deriving it from option order.

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

## Answering

Pending questions replace the normal message composer in an AI conversation. The next question appears directly below the transcript, with the remaining count, suggestion chips, a free-text answer and **Dismiss question**. Answer or dismiss each question in creation order before ordinary messaging returns. The unsent message, attachments and reply draft are preserved. Answering one does not consume the other questions in its batch. **Stop thread** remains available in the header while the agent is running.

- Select any number of suggestions, including none.
- Add text whether or not suggestions are selected.
- A recommendation is labelled; nothing is selected or submitted automatically.
- The only empty-answer error is no selected suggestions and no non-whitespace text.
- Switching conversations does not submit an answer. Failed submissions retain the answer draft for retry.
- **Dismiss question** durably settles that question without selecting or authorizing a suggestion. The agent receives a correlated human steer beginning `Dismissed question QUESTION_ID: PROMPT`, explicitly saying the user skipped it. Dismissal retries are idempotent; an accepted dismissal cannot later be replaced with an answer.

On phones the question composer never takes more than 60dvh; its body scrolls internally while dictation, dismissal and submission stay outside the scrolling body. Suggestion chips and dismissal have at least 48px tap targets. The answer field uses the same Write dictation and phone newline behavior as ordinary messages. Nothing is sent merely by finishing dictation.

Questions survive the agent's turn ending and owner restarts. Answering removes a question from the pending list only after durable acceptance. Repeated delivery of the same answer does not send another message. Questions remain associated with their original thread, including when accessed through an authorized peer owner; an account cannot answer another person's private thread.

## Transport and custody

The owning thread database stores questions and answer receipts. Remote is a client of that owner, not another question store. The model's original tool call and the eventual human answer remain in native Pi history.

- `GET /v1/sessions/:sessionId/questions` returns `{questions}` with pending questions.
- `POST /v1/sessions/:sessionId/questions/:questionId/answer` accepts `{selectedSuggestionIds, text}` or `{selectedSuggestionIds: [], text: "", dismissed: true}` and returns `{accepted: true, questionId}`.
- The selected conversation's shared resource stream publishes `{type: "questions", sessionId, questions}`. It uses the existing reconciliation and reconnect protocol.

A question contains `id`, `threadId`, `question`, `suggestions: [{id, text}]`, optional `recommendedSuggestionId`, and `createdAt`. Suggestions have stable identities so the answer preserves exactly which choices the user selected, alongside their free-form text.

## Notifications

Asking records durable, ordered question occurrences atomically with the questions and their ask receipt. `ThreadApi.questionEvents(after, limit)` pages this owner-local feed; accepted questions are suppressed but still advance the cursor. Remote projects it into the existing `/v1/notifications` and stream feed, with `kind: "question"` and `body` containing the prompt, using a separate durable cursor per thread owner. Projection retries do not duplicate notices. Pending questions recovered from before this feed was introduced are seeded once.

Browser and Android use their existing notification permission and delivery channel. Another thread's question shows a clickable foreground toast, or a private system notification while backgrounded; the visible thread is suppressed because its card is already up. Android polls every permitted environment every 30 seconds in the background and consumes the selected environment's stream immediately in the foreground. Tapping opens that person/environment/thread with the question composer visible. Worker questions notify too, unlike worker completion notices. A completion while questions remain pending does not overwrite the question alert with an idle notice.

The native notification payload and channel presentation changed, so Android needs a new APK, not only a web-bundle update. Build and publish through the existing Android publication workflow; no separate question channel or push credentials are required.

The design follows Codex CLI's immediate acknowledgement/new-user-message contract, inspected at upstream commit `e07e58c8429019de78b138d7138deaaf7f3ef22c`. Pi Stack deliberately differs by retaining pending questions beyond a turn, allowing multiple selections together with text, and marking a recommendation explicitly rather than deriving it from option order.

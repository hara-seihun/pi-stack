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

In an AI conversation, **Questions to answer** sits beside Send below the message field. Its count reflects that thread's pending questions. Opening it shows the questions in creation order, each with its own suggested responses, free-form text field and submission. Answering one does not consume the other questions in its batch.

- Select any number of suggestions, including none.
- Add text whether or not suggestions are selected.
- A recommendation is labelled; nothing is selected or submitted automatically.
- The only empty-answer error is no selected suggestions and no non-whitespace text.
- Closing the panel or switching conversations does not submit an answer. Failed submissions retain the answer draft for retry.

On phones the composer never takes more than 60dvh; its prompt grows up to six rows or 30dvh, then scrolls internally. Questions open in a separately scrollable sheet, where each question keeps its own selections, text and Submit answer control.

Questions survive the agent's turn ending and owner restarts. Answering removes a question from the pending list only after durable acceptance. Repeated delivery of the same answer does not send another message. Questions remain associated with their original thread, including when accessed through an authorized peer owner; an account cannot answer another person's private thread.

## Transport and custody

The owning thread database stores questions and answer receipts. Remote is a client of that owner, not another question store. The model's original tool call and the eventual human answer remain in native Pi history.

- `GET /v1/sessions/:sessionId/questions` returns `{questions}` with pending questions.
- `POST /v1/sessions/:sessionId/questions/:questionId/answer` accepts `{selectedSuggestionIds, text}` and returns `{accepted: true, questionId}`.
- The selected conversation's shared resource stream publishes `{type: "questions", sessionId, questions}`. It uses the existing reconciliation and reconnect protocol.

A question contains `id`, `threadId`, `question`, `suggestions: [{id, text}]`, optional `recommendedSuggestionId`, and `createdAt`. Suggestions have stable identities so the answer preserves exactly which choices the user selected, alongside their free-form text.

The design follows Codex CLI's immediate acknowledgement/new-user-message contract, inspected at upstream commit `e07e58c8429019de78b138d7138deaaf7f3ef22c`. Pi Stack deliberately differs by retaining pending questions beyond a turn, allowing multiple selections together with text, and marking a recommendation explicitly rather than deriving it from option order.

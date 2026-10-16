import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuestionsComposer } from "../../src/features/conversation/questions";
import { NeedsYouCard } from "../../src/needs-you";
import type { ThreadQuestion } from "../../../server/protocol";
import "../../src/attention.css";

window.PiRemotePerson = { get: () => "question-fixture" } as typeof window.PiRemotePerson;
const question: ThreadQuestion = {
  id: "formatting", threadId: "fixture", createdAt: 1,
  question: "**Which appointment works for you?**\n\nBoth are with [the same clinic](https://example.test/clinic). The later slot means waiting **two weeks**.",
  suggestions: [
    { id: "early", text: "**Tuesday, 10 November · 09:30**\nEurope/London · earliest available" },
    { id: "late", text: "**Tuesday, 24 November · 14:00**\nEurope/London · no morning travel" },
  ],
  recommendedSuggestionId: "early",
};
const longQuestion = { ...question, id: "long", question: `${question.question}\n\n### Details\n\n| Appointment | Preparation |\n| --- | --- |\n| Morning | Bring the referral and arrive at 09:15 |\n| Afternoon | Bring the referral and arrive at 13:45 |\n\n${Array.from({ length: 12 }, (_, index) => `- Detail ${index + 1}: long-question scrolling retains every piece of authored context.`).join("\n")}\n\n\`appointment_confirmation_reference_with_a_very_long_identifier_that_must_not_widen_the_page\`\n\n<script>alert('not executable')</script>` };
function Fixture() {
  const [mode, setMode] = useState("short");
  const selected = mode === "long" ? longQuestion : question;
  return <>
    <div className="fixture-controls"><button onClick={() => setMode("short")}>Short question</button><button onClick={() => setMode("long")}>Long question</button><button onClick={() => setMode("attention")}>Attention</button></div>
    {mode === "attention" ? <main className="attention-screen"><NeedsYouCard item={{ id: "question:fixture:formatting", kind: "question", title: question.question, consequence: null, deadline: null, recommendation: question.suggestions[0]!.text, nextAction: null, commitmentId: null, location: { threadId: "fixture", questionId: question.id }, dismissal: { kind: "question", threadId: "fixture", questionId: question.id } }} busy={false} onDismiss={() => {}} /></main> : <><div className="fixture-transcript">The appointment options are ready.</div><QuestionsComposer sessionId="fixture" questions={[selected]} onAccepted={() => {}} /></>}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

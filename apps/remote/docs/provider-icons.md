# Provider icons

The OpenAI and Anthropic logo path data comes from Simple Icons 14.15.0 (`simple-icons`), released under CC0-1.0. Both clients use those logos to say whose model a thread or a plan card belongs to.

The thread-creation menu asks a different question, so it answers with a different kind of sign. Its model choices wear local **S**, **O**, and **F** monograms drawn in one weight, because a logo there would say Anthropic twice and leave Opus and Fable to be told apart by nothing. Provider is carried by the dot's colour instead: OpenAI slate, Anthropic clay for Opus and gold for Fable.

Destinations are places rather than models, so they keep pictograms: a house for the home workspace, a person for private sessions, a briefcase for work sessions, and a bare prompt chevron for raw sessions that carry no harness. These are not provider logos.

The shared [`ORCHESTRATOR_CATALOG`](../../../packages/orchestrator/src/catalog.ts) names model and plan-card glyphs; `THREAD_DESTINATIONS` in [`server/server.ts`](../server/server.ts) names destination glyphs. All are bare names: the web resolves `<name>.svg` and Android `ic_<name>.xml`. A named glyph missing from either client fails quietly, so `bun test` asserts that every name the supervisor offers exists in both.

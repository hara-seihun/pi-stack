# Provider icons

The OpenAI and Anthropic logo path data comes from Simple Icons 14.15.0 (`simple-icons`), released under CC0-1.0. Both clients use those logos to say whose model a thread or a plan card belongs to. Cursor usage uses a local ring-shaped **C** monogram rather than importing another trademark asset.

The thread-creation menu asks a different question, so it answers with a different kind of sign. Its model choices wear local **S**, **O**, and **F** monograms drawn in one weight, because a logo there would say Anthropic twice and leave Opus and Fable to be told apart by nothing. Provider is carried by the dot's colour instead: OpenAI slate, Anthropic clay for Opus and gold for Fable.

Destinations are places rather than models, so they keep pictograms: a house for the local workspace, a person for private sessions, a cloud for a remote host, and a briefcase for work sessions. These are not provider logos.

[`server/provider-manifest.json`](../server/provider-manifest.json) names plan-card glyphs and `THREAD_MODELS`/`THREAD_DESTINATIONS` in [`server/server.ts`](../server/server.ts) name the menu's, in both cases by bare name: the web resolves `<name>.svg` and Android `ic_<name>.xml`. A named glyph missing from either client fails quietly, so `bun test` asserts that every name the supervisor offers exists in both.

# Compaction threshold

This Pi extension starts compaction before a provider request at a model-specific active-context limit:

- Claude Fable and Claude Opus: 500,000 tokens
- Sol: 250,000 tokens
- Other models: 250,000 tokens

`@sting8k/pi-vcc` owns the compaction itself. After compaction, this extension starts the interrupted turn again.

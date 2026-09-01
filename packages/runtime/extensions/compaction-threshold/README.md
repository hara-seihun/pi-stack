# Compaction threshold

This Pi extension starts compaction before a provider request once the active context reaches 250,000 tokens. `@sting8k/pi-vcc` owns the compaction itself. After compaction, the extension starts the interrupted turn again.

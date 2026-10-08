# AMI terminal-word fixtures

`ami-1040.wav` and `ami-4062.wav` are public meeting utterances from the **AMI Consortium, AMI Meeting Corpus**, distributed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**. `manifest.json` preserves dataset/config/split/row, audio/meeting/speaker identity, source intervals, unchanged source text, source checksum and redistributed checksum.

- Corpus: https://groups.inf.ed.ac.uk/ami/corpus/
- Audio/transcription license: https://groups.inf.ed.ac.uk/ami/corpus/license.shtml
- License: https://creativecommons.org/licenses/by/4.0/
- Legal code: https://creativecommons.org/licenses/by/4.0/legalcode
- Redistribution source: https://huggingface.co/datasets/edinburghcstr/ami

Citation: Jean Carletta et al. (2005), *The AMI Meeting Corpus: A Pre-announcement*, Machine Learning for Multimodal Interaction (MLMI), LNCS 3869, pp. 28–39. DOI: 10.1007/11677482_3.

Redistribution changes: selected already-segmented public IHM utterances and converted the viewer's float WAV samples to mono 16 kHz signed PCM16 with ffmpeg. The committed audio is not energy-trimmed, amplified or synthetically filled. The test checks spoken terminal words, not rewritten text. Attribution does not imply endorsement by the speakers or AMI Consortium. These recordings and transcriptions retain CC BY 4.0 independently of the repository's software license.

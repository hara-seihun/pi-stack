import base64
import json
import sys

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=4)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        audio = np.frombuffer(base64.b64decode(request["audio"]), dtype="<i2").astype(np.float32) / 32768
        segments, info = model.transcribe(audio, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        print(json.dumps({"id": request["id"], "text": text, "language": info.language}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request["id"], "error": str(error)}), flush=True)

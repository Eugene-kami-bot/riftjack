# Local voice-message transcription

Optional offline transcription runs before an incoming audio attachment reaches
Codex or Claude. External workers receive the same metadata from the attachment
endpoint; `worker-client.py attachment` preserves it in its JSON result. The
original audio remains available. Text is automatic, potentially inaccurate,
untrusted user content, never connector instructions or approval.

Install [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) and
ffmpeg separately, and provide an existing supported GGUF model. There are no
runtime downloads, cloud recognition requests, microphone access, or Handy
dependencies. For example:

```dotenv
AUDIO_TRANSCRIBE_MODEL=/opt/models/whisper-medium-Q8_0.gguf
AUDIO_TRANSCRIBE_PATH=/opt/transcribe/bin/transcribe-cli
AUDIO_FFMPEG_PATH=/usr/local/bin/ffmpeg
AUDIO_MAX_SECONDS=300
AUDIO_TIMEOUT_SECONDS=120
```

A blank `AUDIO_TRANSCRIBE_MODEL` disables the feature. Missing or invalid audio
settings also disable transcription without stopping the connector. The startup
log and an available owner DM receive a warning explaining what to fix; the
original audio remains available. `--check-config` prints this warning but succeeds
if the rest of the configuration is valid. After correcting the settings, restart
the connector to enable transcription. A path inside any bot workspace disables
the shared recognizer for all bots until restart. All three paths must be
absolute, regular files outside every agent workspace; executables must be
executable. Configure them on the connector host, not through an agent tool.
Native library dependencies must also be installed outside writable workspaces.

The connector reads at most 32 MiB of encoded audio, decodes it to 16 kHz mono
PCM through ffmpeg with only pipe protocols enabled, and rejects audio longer
than the configured duration (1–1800 seconds). A single shared slot across bots
limits GPU/CPU load; a concurrent message receives `unavailable/busy` metadata
instead of waiting in an unbounded queue. The overall processing deadline is
1–600 seconds, including decoding and model startup. Recognition uses two CPU
threads and the engine's automatic backend selection (Metal on Apple Silicon).

Successful attachment metadata includes:

```json
{"transcription":{"status":"complete","text":"Example speech.","automatic":true}}
```

Only up to 32 KiB of recognized text is accepted. Failure, timeout, malformed
audio or an exceeded limit preserves the original attachment and adds an
`unavailable` status with a safe reason; no partial transcript is delivered.
Bridge task cancellation and worker shutdown terminate processing rather than
delivering cancelled input. Worker leases and access are rechecked after recognition before model/worker
delivery. Temporary decoded audio and output are removed after subprocess exit;
the original attachment retains the existing incoming-media retention policy.
Subprocesses never inherit Matrix tokens or other connector credentials, and
audio/transcripts are not copied into diagnostic logs. A worker attachment
request may take longer than the ordinary API calls; the bundled client waits
up to 650 seconds to cover the configured deadline and subprocess shutdown.

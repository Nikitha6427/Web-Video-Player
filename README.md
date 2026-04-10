# Web-Video-Player

## MKV Transcoding Note

MKV transcoding uses FFmpeg.wasm in the browser and requires cross-origin isolation.

- Required headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- On `file://`, MKV transcoding will not work because these headers are unavailable.
- MP4 playback still works on `file://` without a server.

For MKV support, run a local server (for example `npx serve .` or VS Code Live Server) and ensure the headers above are present.

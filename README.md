# desmos

Converts images and video into [Desmos](https://www.desmos.com/calculator) graph
expressions, then renders the result back to pixels. Each traced contour becomes
a pair of point lists (`x_n=[...]`, `y_n=[...]`) plus a `(x_n, y_n)` expression
with `lines: true`, so Desmos itself does the drawing.

![demo](preview.gif)

*2×2 grid: original frame, preprocessed bitmap, potrace output, final Desmos
render. The full-size render (`output.gif`, ~11 MB) is not in the repo — see
releases for demo output.*

## Pipeline

`pipeline.js` — image → expressions → PNG:

1. **Preprocess** (`sharp`): grayscale, normalize contrast, resize to ≤800 px.
2. **Trace** (`potrace`): bitmap → SVG path data (black regions → contours).
3. **Flatten**: parse each `d` attribute; `M`/`L`/`Z` map directly, cubic
   `C` curves are sampled into polylines (8 samples per curve).
4. **Simplify** (`simplify-js`): Ramer–Douglas–Peucker with tolerance 1.5;
   contours under 3 points are dropped, then the top 200 by point count are
   kept and normalized into a ±8 Desmos viewport.
5. **Emit**: one `x_n`/`y_n`/`(x_n,y_n)` triple per contour.
6. **Render** (`puppeteer`): a headless page loads the Desmos calculator API,
   `setState()` loads the expression list, `asyncScreenshot()` returns a PNG.

`video.js` — video → MP4:

1. `ffmpeg` extracts frames at the target fps; `ffprobe` estimates the frame
   count for progress reporting.
2. A `WorkerPool` of `worker_threads` (one per CPU core) runs the trace stage
   in parallel — tracing is CPU-bound and dominates frame time.
3. A `PagePool` of `concurrency` (default 4) puppeteer pages renders frames in
   parallel. Each page owns a persistent calculator instance; frames are
   swapped in via `setState()`. A page that throws or times out is closed,
   replaced, and the frame retried (up to 2 retries).
4. `ffmpeg` stitches the rendered PNGs into an H.264 MP4.

The two pools are independent: trace workers feed a promise queue while the
page pool bounds how many Chromium tabs render at once.

## Usage

```sh
npm install

# single image
node pipeline.js input.png [output.png]

# video (requires ffmpeg + ffprobe on PATH)
node video.js input.mp4 [output.mp4]
```

`index.html` is a minimal standalone smoke test for the calculator API — open
it in a browser and it draws `y = 2x + 1`.

### Options

`traceImage` / `imageToExpressions` accept: `threshold` (128), `rdpTolerance`
(1.5), `maxContours` (200), `bezierSamples` (8), `desmosRange` (8),
`minPoints` (3), `maxWidth` (800).

`videoToDesmos` additionally accepts: `fps` (30), `concurrency` (4 pages),
`width`/`height` (800), `frameTimeout` (60 s), plus all trace options.

## Notes

- The API key in `index.html`, `pipeline.js`, and `video.js`
  (`dcb31709b452b1cf9dc26972add0fda6`) is Desmos's **public demo key** — the
  one they publish for examples — not a private credential.
- Only `M`/`L`/`C`/`Z` SVG commands are handled; that covers everything
  potrace emits.
- Tracing is binary (threshold on grayscale), so color and shading are lost.
- High-contour frames produce very large calculator states; `maxContours` and
  `rdpTolerance` are the knobs to turn when renders get slow.

## License

MIT — see [LICENSE](LICENSE).

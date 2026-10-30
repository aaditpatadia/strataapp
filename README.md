# Strata Studio — AI Content Repurposing Platform

Strata Studio is a full-stack AI content repurposing application that transforms one long-form video or timestamped transcript into a coordinated, brand-aware distribution package:

1. **Source-Linked Content Intelligence Report** (Executive summary, main thesis, explicit statistics, verbatim quotations, arguments classified by epistemic status: *Explicit Speaker Statement*, *Reasonable Interpretation*, or *External Verification Required*).
2. **Shared Multi-Angle Content Strategy Plan** (Distinct content angles mapped to audiences, platforms, and product alignment).
3. **Platform-Specific Written Deliverables** (SEO Blog Articles, Email Newsletters, Multi-Angle LinkedIn Posts, and Timestamped Show Notes).
4. **Intelligent Short-Form Video Clip Discovery & Boundary Validation** (6-axis editorial ranking, programmatic duration & sentence-cut validation, overlap detection).
5. **Real FFmpeg Automated Video Production** (Extracts source intervals, formats to 9:16 portrait via Blurred Background, Fit, or Center Crop, generates synchronized `.srt` captions, and burns in captions, hook banners, and brand overlays).
6. **4-Week Deterministic Content Calendar & ZIP Delivery Package** (Packages `/documents/`, `/videos/`, `/captions/`, and `/metadata/asset-manifest.json`).

---

## 1. Prerequisites & FFmpeg Setup

- **Node.js**: v20+
- **FFmpeg & FFprobe**: Required for video stream probing, clip extraction, aspect ratio conversion, and subtitle rendering.
  - **Ubuntu / Debian**: `sudo apt-get update && sudo apt-get install -y ffmpeg fonts-noto-core fonts-dejavu-core`
  - **macOS (Homebrew)**: `brew install ffmpeg`
  - Verify installation: `ffmpeg -version && ffprobe -version`

---

## 2. Environment Configuration

Copy `.env.example` to `.env` and configure your server-side credentials:

```bash
cp .env.example .env
```

- `GEMINI_API_KEY`: Server-side API key for `@google/genai` (`gemini-3.8-flash` for content intelligence/generation, `gemini-3.5-transcribe` for media transcription). When running in an offline or unconfigured environment, Strata Studio automatically surfaces the configuration status and provides a **Deterministic Transcript Extraction Engine** so workflows and tests can still execute locally at zero API cost.
- `FFMPEG_PATH`: Path to the FFmpeg binary (defaults to `/usr/bin/ffmpeg`).
- `STORAGE_DIR`: Local persistence directory (defaults to `./storage`).

---

## 3. Running Locally

```bash
# Install dependencies
npm install

# Start the Express + Vite full-stack server on http://localhost:3000
npm run dev

# Build for production
npm run build
```

---

## 4. Running Automated Tests

The test suite (`src/lib/coreLogic.test.ts`) uses Node's built-in test runner (`node:test`) via `tsx` and tests:
1. Timestamp parsing and formatting (`HH:MM:SS.mmm`, `MM:SS`, SRT commas).
2. Transcript normalization (SRT, WebVTT, bracketed timestamps, and plain-text estimated timing).
3. Clip duration calculation and boundary validation (sentence cuts, source duration bounds).
4. 6-axis editorial scoring and overlapping clip detection.
5. Brand profile assumption tracking.
6. Structured AI payload validation.
7. Deterministic 4-week content calendar and ZIP export manifest generation.
8. Security path traversal guards and URL platform restriction checks.
9. **Real FFmpeg integration test**: Generates the 90-second HD sample video fixture, extracts a 12-second clip, applies 9:16 blurred-background portrait formatting and burned-in captions, and verifies the output MP4 video/audio streams with `ffprobe`.

```bash
npm test
# or directly:
npx --yes tsx --test src/lib/coreLogic.test.ts
```

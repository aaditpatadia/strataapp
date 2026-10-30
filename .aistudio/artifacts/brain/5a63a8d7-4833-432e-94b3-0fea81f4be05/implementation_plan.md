## App Overview

Strata Studio will be upgraded into an authenticated, cloud-backed AI video production and content repurposing workspace. The update preserves the existing visual identity and all existing projects, uploaded media, brand profiles, and rendered clips while introducing required Google Sign-In via Firebase, accurate speech-to-text transcription powered by Gemini 3.5 Transcribe (for both uploaded media and live microphone recordings), an intelligent FFmpeg short-video production engine that transforms clips into polished shorts with animated word highlights, hook banners, normalized audio, and multi-segment stitching, a keyboard shortcut reference tooltip in the video clip player, and a usage-based credit and pay-as-you-go billing system.

## Design & Aesthetics

The application preserves its approved Strata Studio visual identity (`slate-900` dark controls, crisp white cards with `slate-200` borders, `blue-600` primary actions, and `emerald-600` verification indicators) while refining control density, accessibility, and status clarity:

- **Authenticated Gate & Workspace Header**: A clean, on-brand Google Sign-In gate protects the studio workspace, while the top navigation bar displays the signed-in user's avatar, live credit balance pill, quick top-up trigger, and cloud sync status.
- **Interactive Player Shortcut Tooltip**: A dedicated keyboard shortcut button (`?` / `Shortcuts`) in the `VideoClipsAndRenderSection` player header reveals an accessible, high-contrast overlay listing all transport, frame-stepping, and audio shortcuts.
- **Smart Short-Video Production Controls**: The Video Clips studio integrates an intuitive Smart Production Inspector alongside the existing 7 vertical composition modes, letting creators toggle word-by-word active highlights, 3-second hook title banners, broadcast audio normalization, dead-air trimming, and multi-segment clip stitching.

## Core Features

- **Keyboard Shortcut Help Tooltip in Video Clips Player**:
  - Accessible `? Shortcuts` trigger in the `VideoClipsAndRenderSection` player header with hover, focus, and click support plus `?` hotkey toggle.
  - Displays clear keybindings for Play/Pause (`Space` / `K`), Rewind/Fast-Forward (`J` / `L`), Frame Step Back/Forward (`,` / `.`), Mute (`M`), Fullscreen (`F`), and In/Out boundary nudging.
- **Required Google Sign-In & Cloud Persistence (Firebase Auth + Firestore)**:
  - Requires Google Sign-In before entering the studio workspace.
  - Automatically links and syncs existing local projects, brand profiles, and credit ledger records to the authenticated user's Firestore account so no existing media or work is lost.
- **Audio Transcription & Live Microphone Capture (`gemini-3.5-transcribe`)**:
  - Uses `gemini-3.5-transcribe` on the server to transcribe uploaded audio/video files as well as live microphone voice recordings captured directly in the Source Material & Transcript tabs.
  - Preserves and enhances the 4-stage multilingual pipeline (`Original Script`, `Romanised / Hinglish`, `Bilingual`, and `English Translation`) with speaker diarisation and exact timecodes.
- **Smarter Short-Form Video Production Engine**:
  - **Dynamic Word & Phrase Highlighting**: Synchronized kinetic captions that highlight the active spoken phrase in real time with brand-accent styling.
  - **AI Hook Title Banner**: Optional opening hook card (first 2.5–3.5 seconds) displaying the clip's punchy hook headline at the top safe zone.
  - **Broadcast Audio Mastering & Silence Trimming**: EBU R128 loudness normalization (`loudnorm`) for consistent vocal presence and optional leading/trailing dead-air tightening.
  - **Multi-Segment Highlight Stitcher**: Ability to combine two or more non-contiguous transcript moments into a single cohesive short-form vertical video with smooth transitions.
- **Usage-Based Credit System & Pay-As-You-Go Allowances**:
  - Real-time credit wallet tracking compute consumption across AI Transcription (credits per audio minute), Content Intelligence & Asset Generation, and Smart FFmpeg Rendering (credits per rendered short).
  - Dedicated **Credits & Usage** modal and workspace drawer featuring a live credit meter, itemized usage ledger, pay-as-you-go credit pack top-ups (Starter Pack, Studio Pack, Production Scale Pack), and configurable auto-recharge thresholds.

## Key Screens & User Flows

1. **Google Sign-In Gate & Workspace Migration**:
   - Unauthenticated users see the Strata Studio sign-in screen with a **Continue with Google** button. Upon sign-in, existing studio projects and brand profiles are automatically associated with their account and synced to Firestore.
2. **Source Ingestion & Live Microphone Transcription**:
   - In **02. Source Material** and **03. Transcript**, users can upload media or record directly from their microphone, then run **Transcribe with Gemini 3.5** to generate speaker-diarised, timecoded segments in Original Script and Romanised Hinglish.
3. **Smart Short-Video Production & Keyboard-Driven Editing**:
   - In **06. Video Clips**, users inspect the keyboard shortcut tooltip (`?`), scrub and fine-tune clip boundaries, configure Smart Production Enhancements (Word Highlights, Hook Intro Card, Audio Loudness Mastering, Silence Trim, or Multi-Segment Stitch), and render a finished 9:16, 1:1, or 16:9 MP4.
4. **Usage Credits & Pay-As-You-Go Top-Up Flow**:
   - Clicking the header credit pill opens the **Credits & Pay-As-You-Go Billing** center where users inspect their remaining credits, view per-action credit costs and history, and add pay-as-you-go credit packs immediately.

## Technical Architecture & Integrations

- **Firebase Authentication & Cloud Firestore**:
  - Google Sign-In via Firebase Auth (`signInWithPopup`) with strict `firestore.rules` enforcing owner-only access to `users/{uid}`, `projects/{projectId}`, `brands/{brandId}`, and `creditTransactions/{txId}`.
  - Hybrid synchronization layer keeping Firestore user/project/credit state in sync with the local Express + FFmpeg media storage engine.
- **Gemini 3.5 Audio Transcription (`@google/genai`)**:
  - Server-side transcription pipeline using `gemini-3.5-transcribe` for uploaded media audio tracks and browser `MediaRecorder` microphone captures, paired with structured diarisation and Romanised transliteration.
- **Upgraded FFmpeg Smart Compositor**:
  - Extended filtergraph builder in `/src/server/ffmpegEngine.ts` supporting multi-segment concatenation (`concat` filter), EBU R128 audio normalization (`loudnorm=I=-16:TP=-1.5:LRA=11`), timed hook banner overlays, and multi-color active-phrase subtitle rendering with resilient fallback protection.

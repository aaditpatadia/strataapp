import { ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  SHORT_FORM_MAX_DURATION_SEC,
  calculateClipDuration,
  extractImpactHighlightWords,
  generateClipSrt,
  sanitizeFilename,
  validateSafeProjectPath,
} from '../lib/coreLogic';
import type {
  ClipRenderConfiguration,
  TranscriptSegment,
} from '../types/domain';

const execFileAsync = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE_BIN = '/usr/bin/ffprobe';

const FONT_PATHS: Record<string, string> = {
  'NotoSans-Bold': '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  'DejaVuSans-Bold': '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  'DejaVuSansMono-Bold': '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
};

function resolveFontPath(preferred?: string): string {
  if (preferred && FONT_PATHS[preferred] && fs.existsSync(FONT_PATHS[preferred])) {
    return FONT_PATHS[preferred];
  }
  for (const p of Object.values(FONT_PATHS)) {
    if (fs.existsSync(p)) return p;
  }
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
}

/**
 * Escapes text for FFmpeg drawtext filter according to FFmpeg filtergraph escaping rules.
 * Removes or escapes characters that break filter_complex parsing (: , ; ' \ [ ] %).
 */
export function escapeDrawtext(text: string): string {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/['"`]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/;/g, ',')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .trim();
}

export interface MediaProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  hasVideo: boolean;
  hasAudio: boolean;
  hasSubtitles?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  fileSizeBytes: number;
}

function parseFrameRate(rawRate?: string): number {
  if (!rawRate || typeof rawRate !== 'string') return 30;
  if (rawRate.includes('/')) {
    const [num, den] = rawRate.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const fps = Math.round((num / den) * 100) / 100;
      return fps > 0 && fps <= 240 ? fps : 30;
    }
  }
  const direct = parseFloat(rawRate);
  return Number.isFinite(direct) && direct > 0 ? Math.round(direct * 100) / 100 : 30;
}

export async function probeMediaFile(filePath: string): Promise<MediaProbeResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source media file not found on storage: ${path.basename(filePath)}`);
  }

  const stat = fs.statSync(filePath);
  const { stdout } = await execFileAsync(
    FFPROBE_BIN,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration',
      '-of',
      'json',
      filePath,
    ],
    { timeout: 20000 }
  );

  const parsed = JSON.parse(stdout || '{}');
  const streams: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: string | number;
  }> = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const subtitleStream = streams.find((s) => s.codec_type === 'subtitle');

  const candidates = [
    parseFloat(String(parsed.format?.duration ?? '0')),
    parseFloat(String(videoStream?.duration ?? '0')),
    parseFloat(String(audioStream?.duration ?? '0')),
  ].filter((d) => Number.isFinite(d) && d > 0);

  const bestDuration = candidates.length > 0 ? Math.max(...candidates) : 0;
  const frameRate = parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate);

  return {
    durationSeconds: bestDuration > 0 ? Math.round(bestDuration * 100) / 100 : 0,
    width: videoStream?.width || 1280,
    height: videoStream?.height || 720,
    frameRate,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    hasSubtitles: Boolean(subtitleStream),
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    fileSizeBytes: stat.size,
  };
}

/**
 * Runs FFmpeg using structured process arguments via spawn (never shell interpolation),
 * supports cancellation hooks and timeout, and captures only clean stderr tail on failure.
 */
function runFfmpegStructured(
  args: string[],
  options: {
    timeoutMs?: number;
    onSpawn?: (proc: ChildProcess) => void;
    stageLabel: string;
  }
): Promise<{ exitCode: number; stderrTail: string }> {
  const { timeoutMs = 75000, onSpawn, stageLabel } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (onSpawn) {
      onSpawn(proc);
    }

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      if (stderrBuf.length > 8192) {
        stderrBuf = stderrBuf.slice(-6144);
      }
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(
        new Error(
          `[${stageLabel}] Video encode timed out after ${Math.round(timeoutMs / 1000)}s.`
        )
      );
    }, timeoutMs);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`[${stageLabel}] Process spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const cleanLines = stderrBuf
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(
          (l) =>
            l.length > 0 &&
            !l.startsWith('ffmpeg version') &&
            !l.startsWith('built with') &&
            !l.startsWith('configuration:') &&
            !l.startsWith('lib') &&
            !l.includes('--enable-')
        );
      const stderrTail = cleanLines.slice(-4).join(' | ');

      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        reject(new Error(`[${stageLabel}] Render job cancelled by user.`));
        return;
      }

      if (code === 0) {
        resolve({ exitCode: 0, stderrTail });
      } else {
        reject(
          new Error(
            `[${stageLabel}] FFmpeg exited with code ${code ?? 1}: ${
              stderrTail || 'Filtergraph or media stream error.'
            }`
          )
        );
      }
    });
  });
}

/**
 * Ensures an uploaded video file is browser-playable (H.264 + AAC MP4 with faststart)
 * and has a valid probed duration.
 */
export async function ensureWebPlayableVideo(
  filePath: string,
  uploadsDir: string,
  hintDurationSec?: number
): Promise<{ finalPath: string; probe: MediaProbeResult }> {
  let probe: MediaProbeResult;
  try {
    probe = await probeMediaFile(filePath);
  } catch {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : { size: 0 };
    probe = {
      durationSeconds: hintDurationSec && hintDurationSec > 0 ? hintDurationSec : 30,
      width: 1280,
      height: 720,
      frameRate: 30,
      hasVideo: true,
      hasAudio: true,
      fileSizeBytes: stat.size,
    };
  }

  if (probe.durationSeconds <= 0 && hintDurationSec && hintDurationSec > 0) {
    probe.durationSeconds = Math.round(hintDurationSec * 100) / 100;
  }

  const ext = path.extname(filePath).toLowerCase();
  const isWebCodec =
    !probe.videoCodec || ['h264', 'vp8', 'vp9', 'av1'].includes(probe.videoCodec);

  const needsNormalization =
    probe.hasVideo &&
    (probe.durationSeconds <= 0 ||
      !['.mp4', '.webm', '.m4v'].includes(ext) ||
      !isWebCodec);

  if (!needsNormalization) {
    if (probe.durationSeconds <= 0) {
      probe = { ...probe, durationSeconds: hintDurationSec || 30 };
    }
    return { finalPath: filePath, probe };
  }

  fs.mkdirSync(uploadsDir, { recursive: true });
  const baseName = sanitizeFilename(path.basename(filePath, ext));
  const normalizedPath = path.join(uploadsDir, `${baseName}-web.mp4`);

  // Fast path 1: If already H.264 in .mov / .mkv / .mp4 container, remux via stream copy (-c:v copy)
  if (probe.videoCodec === 'h264') {
    try {
      const remuxArgs: string[] = ['-y', '-i', filePath, '-c:v', 'copy'];
      if (probe.hasAudio) {
        remuxArgs.push('-c:a', 'aac', '-b:a', '128k');
      }
      remuxArgs.push('-movflags', '+faststart', normalizedPath);
      await runFfmpegStructured(remuxArgs, {
        timeoutMs: 20000,
        stageLabel: 'REMUX_FASTSTART',
      });
      const remuxProbe = await probeMediaFile(normalizedPath);
      if (remuxProbe.hasVideo && remuxProbe.fileSizeBytes > 512) {
        return {
          finalPath: normalizedPath,
          probe: {
            ...remuxProbe,
            durationSeconds:
              remuxProbe.durationSeconds > 0
                ? remuxProbe.durationSeconds
                : probe.durationSeconds || hintDurationSec || 30,
          },
        };
      }
    } catch {
      // Fall through if stream copy fails
    }
  }

  // Fast path 2: Full ultrafast normalization when codec is non-web
  try {
    const args: string[] = [
      '-y',
      '-i',
      filePath,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
    ];
    if (probe.hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart', normalizedPath);

    await runFfmpegStructured(args, {
      timeoutMs: 60000,
      stageLabel: 'NORMALIZE_WEB_MP4',
    });
    const newProbe = await probeMediaFile(normalizedPath);
    if (newProbe.hasVideo && newProbe.fileSizeBytes > 512) {
      if (newProbe.durationSeconds <= 0) {
        newProbe.durationSeconds = probe.durationSeconds || hintDurationSec || 30;
      }
      return { finalPath: normalizedPath, probe: newProbe };
    }
  } catch {
    // Fall back to original file
  }

  return { finalPath: filePath, probe };
}

/**
 * Extracts embedded subtitle track (if present) and compact mono MP3 audio chunks
 * for full-recording multilingual transcription.
 */
export async function extractMediaForTranscription(
  filePath: string,
  tempDir: string,
  chunkDurationSec = 300,
  overlapSec = 2
): Promise<{
  embeddedSrt?: string;
  audioFilePath?: string;
  audioChunks: Array<{ chunkIndex: number; startSec: number; durationSec: number; filePath: string }>;
  mimeType: string;
}> {
  fs.mkdirSync(tempDir, { recursive: true });
  const probe = await probeMediaFile(filePath);
  let embeddedSrt: string | undefined;

  if (probe.hasSubtitles) {
    const srtOut = path.join(tempDir, 'embedded.srt');
    try {
      await runFfmpegStructured(['-y', '-i', filePath, '-map', '0:s:0', srtOut], {
        timeoutMs: 15000,
        stageLabel: 'EXTRACT_SUBTITLES',
      });
      if (fs.existsSync(srtOut)) {
        const content = fs.readFileSync(srtOut, 'utf-8').trim();
        if (content.length > 10) {
          embeddedSrt = content;
        }
      }
    } catch {
      // Ignore if subtitle codec cannot be converted to SRT
    }
  }

  const audioChunks: Array<{
    chunkIndex: number;
    startSec: number;
    durationSec: number;
    filePath: string;
  }> = [];

  if (probe.hasAudio) {
    const totalSec = Math.max(1, probe.durationSeconds || 60);
    // Extract up to 12 chunks (covering up to 60 minutes) or single compact audio file
    const effectiveChunkSec = Math.max(60, chunkDurationSec);
    const totalChunks = Math.min(12, Math.max(1, Math.ceil(totalSec / effectiveChunkSec)));

    for (let i = 0; i < totalChunks; i++) {
      const startSec = Math.max(0, i * effectiveChunkSec - (i > 0 ? overlapSec : 0));
      const durationSec = Math.min(totalSec - startSec, effectiveChunkSec + overlapSec);
      if (durationSec <= 0.5) break;

      const chunkOut = path.join(tempDir, `audio-chunk-${String(i).padStart(2, '0')}.mp3`);
      try {
        await runFfmpegStructured(
          [
            '-y',
            '-ss',
            String(startSec),
            '-t',
            String(durationSec),
            '-i',
            filePath,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-b:a',
            '32k',
            chunkOut,
          ],
          { timeoutMs: 25000, stageLabel: `AUDIO_CHUNK_${i}` }
        );
        if (fs.existsSync(chunkOut) && fs.statSync(chunkOut).size > 256) {
          audioChunks.push({
            chunkIndex: i,
            startSec,
            durationSec,
            filePath: chunkOut,
          });
        }
      } catch {
        // Continue with remaining chunks
      }
    }
  }

  return {
    embeddedSrt,
    audioFilePath: audioChunks[0]?.filePath,
    audioChunks,
    mimeType: 'audio/mp3',
  };
}

/**
 * Deterministically generates a real 90-second Studio Keynote Master MP4 video
 * with 6 chapter cards, speaker plates, and a multi-frequency voice-band audio track.
 */
export async function ensureSampleKeynoteVideo(
  outputFilePath: string
): Promise<MediaProbeResult> {
  if (fs.existsSync(outputFilePath)) {
    try {
      const probe = await probeMediaFile(outputFilePath);
      if (probe.durationSeconds >= 88 && probe.hasVideo && probe.hasAudio) {
        return probe;
      }
    } catch {
      // Regenerate if corrupted
    }
  }

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  const fontFile = resolveFontPath('NotoSans-Bold');

  const chapters = [
    {
      start: 0,
      end: 15,
      chapter: 'CHAPTER 01 / THE 38 PERCENT IDLE COMPUTE TAX',
      quote: 'Most enterprise Kubernetes clusters pay a 38 percent idle compute tax.',
    },
    {
      start: 15,
      end: 30,
      chapter: 'CHAPTER 02 / 42 PRODUCTION CLUSTERS AUDITED',
      quote: 'Root cause is static launch memory reservations - not traffic spikes.',
    },
    {
      start: 30,
      end: 45,
      chapter: 'CHAPTER 03 / THE 2 AM PAGER INCENTIVE GAP',
      quote: 'Engineers pad pods by 300 percent because nobody gets paged for oversized pods.',
    },
    {
      start: 45,
      end: 60,
      chapter: 'CHAPTER 04 / WHY FINANCE SPREADSHEETS FAIL',
      quote: 'Reliability always beats quarterly cost spreadsheets on the production floor.',
    },
    {
      start: 60,
      end: 75,
      chapter: 'CHAPTER 05 / PIPELINE P99 HISTOGRAMS + BURST BUFFER',
      quote: 'Automated vertical burst buffers eliminate OOMKill anxiety in CI/CD.',
    },
    {
      start: 75,
      end: 90,
      chapter: 'CHAPTER 06 / 31 PERCENT LOWER UNIT COMPUTE COST',
      quote: 'Unit compute cost per 1,000 API requests dropped 31 percent with zero OOM regressions.',
    },
  ];

  const drawtextFilters: string[] = [
    `drawbox=x=0:y=0:w=1280:h=96:color=#0B0F17@0.92:t=fill`,
    `drawbox=x=0:y=600:w=1280:h=120:color=#0B0F17@0.92:t=fill`,
    `drawbox=x=64:y=156:w=1152:h=396:color=#1E293B@0.72:t=fill`,
    `drawtext=fontfile='${fontFile}':text='VANGUARD CLOUD SYSTEMS  |  Q4 ARCHITECTURE KEYNOTE':x=64:y=36:fontsize=24:fontcolor=#60A5FA`,
    `drawtext=fontfile='${fontFile}':text='SPEAKER\\: DR. ELENA VANCE (CTO)   |   SOURCE MASTER':x=64:y=190:fontsize=22:fontcolor=#94A3B8`,
    `drawtext=fontfile='${fontFile}':text='TIMECODE\\: %{pts\\:hms}':x=940:y=36:fontsize=24:fontcolor=#F8FAFC`,
  ];

  for (const ch of chapters) {
    const chEsc = escapeDrawtext(ch.chapter);
    const qEsc = escapeDrawtext(ch.quote);
    drawtextFilters.push(
      `drawtext=fontfile='${fontFile}':text='${chEsc}':x=96:y=275:fontsize=30:fontcolor=#38BDF8:enable='between(t,${ch.start},${ch.end})'`
    );
    drawtextFilters.push(
      `drawtext=fontfile='${fontFile}':text='${qEsc}':x=96:y=345:fontsize=26:fontcolor=#F8FAFC:enable='between(t,${ch.start},${ch.end})'`
    );
  }

  const vfChain = drawtextFilters.join(',');

  await runFfmpegStructured(
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=#0F172A:s=1280x720:r=24:d=90',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100:duration=90',
      '-vf',
      vfChain,
      '-af',
      'volume=0.08,apulsator=mode=sine:hz=2.5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-shortest',
      outputFilePath,
    ],
    { timeoutMs: 45000, stageLabel: 'GENERATE_SAMPLE_KEYNOTE' }
  );

  return probeMediaFile(outputFilePath);
}

export async function ensureSampleMediaFixture(fixturesDir: string): Promise<string> {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const samplePath = path.join(fixturesDir, 'sample-keynote.mp4');
  await ensureSampleKeynoteVideo(samplePath);
  return samplePath;
}

export interface RenderClipParams {
  sourceFilePath: string;
  outputDir: string;
  tempDir?: string;
  clipId: string;
  clipTitle: string;
  brandLogoText: string;
  onScreenHook: string;
  start: number;
  end: number;
  transcript: TranscriptSegment[];
  config: ClipRenderConfiguration;
  simulateFailure?: boolean;
  onStageChange?: (
    stage:
      | 'STAGE_A_VERIFY'
      | 'STAGE_B_EXTRACT'
      | 'STAGE_C_LAYOUT'
      | 'STAGE_D_CAPTIONS'
      | 'STAGE_E_ENCODE'
      | 'STAGE_F_VALIDATE'
      | 'DONE'
  ) => void;
  onProcessSpawn?: (proc: ChildProcess) => void;
  timeoutMs?: number;
}

export interface RenderClipResult {
  outputFilePath: string;
  outputFilename: string;
  srtFilePath: string;
  srtFilename: string;
  probe: MediaProbeResult;
  timingConfidence: 'verified' | 'estimated';
  usedFallbackEncode?: boolean;
}

function wrapCaptionLines(text: string, maxCharsPerLine: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxCharsPerLine) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

/**
 * Staged FFmpeg Rendering Pipeline (Stages A -> F) with fast keyframe demuxer seeking,
 * strict <=120s short-form validation, filtergraph escaping, cancellation hooks, and fallback recovery.
 */
export async function renderVideoClipWithFfmpeg(
  params: RenderClipParams
): Promise<RenderClipResult> {
  const {
    sourceFilePath,
    outputDir,
    tempDir,
    clipId,
    brandLogoText,
    onScreenHook,
    start,
    end,
    transcript,
    config,
    simulateFailure,
    onStageChange,
    onProcessSpawn,
    timeoutMs = 75000,
  } = params;

  // STAGE A: Verify source video and metadata
  onStageChange?.('STAGE_A_VERIFY');
  if (simulateFailure) {
    throw new Error(
      `[STAGE_A_VERIFY] Simulated rendering failure triggered for diagnostic queue verification (${clipId}).`
    );
  }

  const sourceProbe = await probeMediaFile(sourceFilePath);
  const duration = calculateClipDuration(start, end);

  if (duration <= 0) {
    throw new Error(`[STAGE_A_VERIFY] Invalid clip duration (${duration}s) for start=${start}, end=${end}.`);
  }
  if (duration > SHORT_FORM_MAX_DURATION_SEC + 0.5) {
    throw new Error(
      `[STAGE_A_VERIFY] Clip duration (${duration}s) exceeds the 120s maximum for Instagram Reels and YouTube Shorts.`
    );
  }
  if (sourceProbe.durationSeconds > 0 && end > sourceProbe.durationSeconds + 1) {
    throw new Error(
      `[STAGE_A_VERIFY] Clip end timestamp (${end}s) exceeds source video duration (${sourceProbe.durationSeconds}s).`
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const workTempDir = tempDir || path.join(outputDir, 'temp');
  fs.mkdirSync(workTempDir, { recursive: true });

  const safeId = sanitizeFilename(clipId);
  const stamp = Date.now().toString(36);
  const outputFilename = `${safeId}-${stamp}.mp4`;
  const srtFilename = `${safeId}-${stamp}.srt`;

  const pathCheck = validateSafeProjectPath(outputDir, outputFilename);
  const srtCheck = validateSafeProjectPath(outputDir, srtFilename);
  if (!pathCheck.safe || !srtCheck.safe) {
    throw new Error(pathCheck.error || srtCheck.error || 'Unsafe output path.');
  }

  // Generate synchronized clip-relative SRT file using the selected caption script mode (Original, Romanised, Both, or Translation)
  const { srtContent, timingConfidence } = generateClipSrt(
    transcript,
    start,
    end,
    config.captionStyle?.maxWordsPerSegment || 7,
    config.captionScriptMode || 'original'
  );
  fs.writeFileSync(srtCheck.resolvedPath, srtContent, 'utf-8');

  // STAGE B: Extract requested segment cleanly or prepare fast keyframe input seek
  onStageChange?.('STAGE_B_EXTRACT');
  const segmentTempPath = path.join(workTempDir, `seg-${safeId}-${stamp}.mp4`);
  let inputForFilterPath = sourceFilePath;
  let useExtractedSegment = false;

  try {
    // Fast keyframe demuxer extraction (-ss BEFORE -i, followed by -t duration)
    // This makes extracting a 45s clip at minute 40 of a 65-minute video near-instant!
    const extractArgs: string[] = [
      '-y',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      sourceFilePath,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
    ];
    if (sourceProbe.hasAudio) {
      extractArgs.push('-c:a', 'aac', '-b:a', '128k');
    } else {
      extractArgs.push('-an');
    }
    extractArgs.push(segmentTempPath);

    await runFfmpegStructured(extractArgs, {
      timeoutMs: Math.min(45000, timeoutMs),
      onSpawn: onProcessSpawn,
      stageLabel: 'STAGE_B_EXTRACT',
    });

    if (fs.existsSync(segmentTempPath) && fs.statSync(segmentTempPath).size > 1024) {
      inputForFilterPath = segmentTempPath;
      useExtractedSegment = true;
    }
  } catch {
    // If intermediate segment extraction fails, fall back to direct input seeking in Stage E
    useExtractedSegment = false;
  }

  // STAGE C: Aspect ratio crop, scale, padding
  onStageChange?.('STAGE_C_LAYOUT');
  let targetW =
    config.width && config.width > 0 && config.width <= 1080 ? config.width : 540;
  let targetH =
    config.height && config.height > 0 && config.height <= 1920
      ? config.height
      : 960;
  if (config.aspectRatio === '1:1') {
    targetW = config.width && config.width <= 1080 ? config.width : 720;
    targetH = targetW;
  } else if (config.aspectRatio === '16:9') {
    targetW = config.width && config.width <= 1920 ? config.width : 1280;
    targetH = config.height && config.height <= 1080 ? config.height : 720;
  } else if (config.aspectRatio === 'original') {
    targetW = Math.max(320, Math.min(1280, sourceProbe.width || 1280));
    targetH = Math.max(240, Math.min(720, sourceProbe.height || 720));
  }
  targetW = Math.max(160, Math.floor(targetW / 2) * 2);
  targetH = Math.max(160, Math.floor(targetH / 2) * 2);

  // STAGE D: Apply captions & branding overlays
  onStageChange?.('STAGE_D_CAPTIONS');
  const fontFile = resolveFontPath(config.captionStyle?.fontFamily);
  const scaleRatio = targetH / 1920;
  const scaledFontSize = Math.max(
    18,
    Math.round((config.captionStyle?.fontSize || 36) * scaleRatio)
  );
  const safeMarginY = Math.max(
    48,
    Math.round((config.captionStyle?.safeMarginPx || 120) * scaleRatio)
  );

  const overlayFilters: string[] = [];

  if (config.showBrandLogoOverlay && brandLogoText) {
    const cleanLogo = escapeDrawtext(brandLogoText.slice(0, 28));
    if (cleanLogo) {
      overlayFilters.push(
        `drawtext=fontfile='${fontFile}':text='${cleanLogo}':x=32:y=36:fontsize=16:fontcolor=white:box=1:boxcolor=#0F172A@0.85:boxborderw=10`
      );
    }
  }

  if (config.showHookTitleOverlay && onScreenHook) {
    const hookLines = wrapCaptionLines(onScreenHook, 32).slice(0, 2);
    hookLines.forEach((line, idx) => {
      const cleanLine = escapeDrawtext(line);
      if (cleanLine) {
        const yPos = 96 + idx * 26;
        overlayFilters.push(
          `drawtext=fontfile='${fontFile}':text='${cleanLine}':x=(w-text_w)/2:y=${yPos}:fontsize=18:fontcolor=#F8FAFC:box=1:boxcolor=#1D4ED8@0.9:boxborderw=10:enable='between(t\\,0\\,6)'`
        );
      }
    });
  }

  if (config.burnInCaptions) {
    const blocks = srtContent
      .trim()
      .split(/\r?\n\r?\n+/)
      .filter(Boolean)
      .slice(0, 18); // Cap at 18 phrase blocks so filter_complex never overflows

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      if (lines.length < 3) continue;
      const timeMatch = lines[1].match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
      );
      if (!timeMatch) continue;
      const cueStart =
        Number(timeMatch[1]) * 3600 +
        Number(timeMatch[2]) * 60 +
        Number(timeMatch[3]) +
        Number(timeMatch[4]) / 1000;
      const cueEnd =
        Number(timeMatch[5]) * 3600 +
        Number(timeMatch[6]) * 60 +
        Number(timeMatch[7]) +
        Number(timeMatch[8]) / 1000;

      const textBody = lines.slice(2).join(' ');
      const wrapped = wrapCaptionLines(
        textBody,
        config.captionStyle?.maxLineLengthChars || 32
      );

      wrapped.forEach((wLine, lineIdx) => {
        const escaped = escapeDrawtext(wLine);
        if (!escaped) return;
        const lineOffset =
          (wrapped.length - 1 - lineIdx) * Math.round(scaledFontSize * 1.35);
        const yExpr =
          config.captionStyle?.position === 'top'
            ? `${safeMarginY + 70 + lineIdx * Math.round(scaledFontSize * 1.35)}`
            : config.captionStyle?.position === 'center'
              ? `(h/2)+${lineIdx * Math.round(scaledFontSize * 1.35)}`
              : `h-${safeMarginY}-${lineOffset}`;

        overlayFilters.push(
          `drawtext=fontfile='${fontFile}':text='${escaped}':x=(w-text_w)/2:y=${yExpr}:fontsize=${scaledFontSize}:fontcolor=white:box=1:boxcolor=#0F172A@0.85:boxborderw=8:enable='between(t\\,${cueStart.toFixed(2)}\\,${cueEnd.toFixed(2)})'`
        );
      });
    }
  }

  const buildFilterComplex = (includeOverlays: boolean) => {
    const overlayChain =
      includeOverlays && overlayFilters.length > 0
        ? `,${overlayFilters.join(',')}`
        : '';

    const mode = config.layoutMode || 'blurred-background';
    const manual = config.manualCrop || {
      horizontalOffset: 0,
      verticalOffset: 0,
      zoom: 1.0,
    };
    const normX = Math.max(0, Math.min(1, (manual.horizontalOffset + 100) / 200));
    const normY = Math.max(0, Math.min(1, (manual.verticalOffset + 100) / 200));
    const zoomFactor = Math.max(1.0, Math.min(2.5, manual.zoom || 1.0));
    const zoomedW = Math.floor((targetW * zoomFactor) / 2) * 2;
    const zoomedH = Math.floor((targetH * zoomFactor) / 2) * 2;

    if (mode === 'blurred-background' && config.aspectRatio !== '16:9' && config.aspectRatio !== 'original') {
      return `[0:v]split=2[bg][fg];[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=16:4[bgblur];[fg]scale=${targetW}:-2:force_original_aspect_ratio=decrease[fgscaled];[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2${overlayChain}[vout]`;
    } else if (mode === 'split-screen' && config.aspectRatio === '9:16') {
      const halfH = Math.floor(targetH / 4) * 2;
      const remH = targetH - halfH;
      return `[0:v]split=2[topsrc][botsrc];[topsrc]scale=${Math.floor(targetW * 1.45)}:${halfH}:force_original_aspect_ratio=increase,crop=${targetW}:${halfH}:(iw-ow)*0.22:(ih-oh)*0.35,drawbox=x=0:y=${halfH - 3}:w=${targetW}:h=3:color=#38BDF8@0.9:t=fill[topv];[botsrc]scale=${Math.floor(targetW * 1.45)}:${remH}:force_original_aspect_ratio=increase,crop=${targetW}:${remH}:(iw-ow)*0.78:(ih-oh)*0.35[botv];[topv][botv]vstack=inputs=2${overlayChain}[vout]`;
    } else if (mode === 'picture-in-picture') {
      const pipW = Math.floor((targetW * 0.38) / 2) * 2;
      const pipH = Math.floor((pipW * 1.15) / 2) * 2;
      return `[0:v]split=3[bg][main][pip];[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=18:4[bgblur];[main]scale=${targetW}:-2:force_original_aspect_ratio=decrease[mainfg];[pip]scale=${Math.floor(pipW * 1.6)}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH}:(iw-ow)*0.5:(ih-oh)*0.28,drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=#38BDF8:t=4[pipbox];[bgblur][mainfg]overlay=(W-w)/2:(H-h)*0.34[base];[base][pipbox]overlay=W-w-24:H-h-${Math.max(120, safeMarginY + 36)}${overlayChain}[vout]`;
    } else if (mode === 'speaker-focus') {
      return `[0:v]scale=${Math.floor(targetW * 1.18)}:${Math.floor(targetH * 1.18)}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:(iw-ow)*0.50:(ih-oh)*0.28${overlayChain}[vout]`;
    } else if (mode === 'dynamic-speaker') {
      // Shift horizontal framing dynamically between Speaker 1 (0.28) and Speaker 2 (0.72) based on clip time
      const midTurn = Math.max(2, Math.round((duration / 2) * 10) / 10);
      return `[0:v]scale=${Math.floor(targetW * 1.25)}:${Math.floor(targetH * 1.12)}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:'if(lt(t\\,${midTurn})\\,(iw-ow)*0.32\\,(iw-ow)*0.68)':(ih-oh)*0.30${overlayChain}[vout]`;
    } else if (mode === 'manual-reframe' || mode === 'smart-crop') {
      return `[0:v]scale=${zoomedW}:${zoomedH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:(iw-ow)*${normX.toFixed(3)}:(ih-oh)*${normY.toFixed(3)}${overlayChain}[vout]`;
    } else if (mode === 'fit') {
      return `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=#0F172A${overlayChain}[vout]`;
    } else {
      return `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}${overlayChain}[vout]`;
    }
  };

  // STAGE E: Encode final output (with automatic stage fallback if complex drawtext fails)
  onStageChange?.('STAGE_E_ENCODE');
  let usedFallbackEncode = false;

  const buildEncodeArgs = (filterStr: string): string[] => {
    const args: string[] = ['-y'];
    if (!useExtractedSegment) {
      // Fast input seek BEFORE -i
      args.push('-ss', String(start), '-t', String(duration));
    }
    args.push(
      '-i',
      inputForFilterPath,
      '-filter_complex',
      filterStr,
      '-map',
      '[vout]'
    );
    if (sourceProbe.hasAudio) {
      args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      pathCheck.resolvedPath
    );
    return args;
  };

  try {
    await runFfmpegStructured(buildEncodeArgs(buildFilterComplex(true)), {
      timeoutMs,
      onSpawn: onProcessSpawn,
      stageLabel: 'STAGE_E_ENCODE',
    });
  } catch (primaryErr) {
    // If user cancelled, do not run fallback
    if (String(primaryErr).includes('cancelled by user')) {
      if (useExtractedSegment && fs.existsSync(segmentTempPath)) {
        try {
          fs.unlinkSync(segmentTempPath);
        } catch {
          // ignore
        }
      }
      throw primaryErr;
    }

    // Fallback: If drawtext overlay filter failed due to special unicode glyphs, encode clean framed aspect-ratio video + SRT sidecar
    usedFallbackEncode = true;
    await runFfmpegStructured(buildEncodeArgs(buildFilterComplex(false)), {
      timeoutMs: Math.min(45000, timeoutMs),
      onSpawn: onProcessSpawn,
      stageLabel: 'STAGE_E_FALLBACK_ENCODE',
    });
  } finally {
    if (useExtractedSegment && fs.existsSync(segmentTempPath)) {
      try {
        fs.unlinkSync(segmentTempPath);
      } catch {
        // ignore
      }
    }
  }

  // STAGE F: Verify the resulting file
  onStageChange?.('STAGE_F_VALIDATE');
  const outputProbe = await probeMediaFile(pathCheck.resolvedPath);
  if (!outputProbe.hasVideo || outputProbe.fileSizeBytes < 1024) {
    throw new Error(
      '[STAGE_F_VALIDATE] Rendered clip validation failed: Output file is empty or missing video stream.'
    );
  }

  onStageChange?.('DONE');
  return {
    outputFilePath: pathCheck.resolvedPath,
    outputFilename,
    srtFilePath: srtCheck.resolvedPath,
    srtFilename,
    probe: outputProbe,
    timingConfidence,
    usedFallbackEncode,
  };
}

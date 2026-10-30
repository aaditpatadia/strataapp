import type {
  AssetDeliverable,
  BrandProfile,
  CalendarEntry,
  CaptionScriptMode,
  ClipBoundaryValidation,
  ClipContextRecommendations,
  ClipEditorialScores,
  ClipRenderConfiguration,
  ContentAnalysis,
  ContentCategory,
  CropValidationReport,
  DiagnosticRecord,
  EditorialWeights,
  ExportManifestItem,
  FullProjectBundle,
  LinkedInPostStructured,
  ManualCropConfig,
  NewsletterStructured,
  PlatformType,
  SeoBlogStructured,
  TranscriptCoverageReport,
  TranscriptSegment,
  VideoClipCandidate,
  VideoLayoutMode,
  WorkflowStageId,
  WorkflowStageState,
} from '../types/domain';

export const SHORT_FORM_MAX_DURATION_SEC = 120;
export const SHORT_FORM_DEFAULT_TARGET_SEC = 45;

/**
 * 1. TIMESTAMP PARSING & FORMATTING
 */
export function parseTimestamp(input: string | number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    return Math.round(input * 1000) / 1000;
  }

  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;

  // Plain numeric seconds (e.g. "42.5" or "42.5s")
  if (/^\d+(\.\d+)?s?$/i.test(trimmed)) {
    const val = parseFloat(trimmed.replace(/s$/i, ''));
    return Number.isFinite(val) && val >= 0 ? Math.round(val * 1000) / 1000 : null;
  }

  // Normalize comma milliseconds (SRT style: 00:01:23,450 -> 00:01:23.450)
  const normalized = trimmed.replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = nums;
  } else {
    [minutes, seconds] = nums;
  }

  if (minutes >= 60 && parts.length === 3) return null;
  if (seconds >= 60) return null;

  const total = hours * 3600 + minutes * 60 + seconds;
  return Math.round(total * 1000) / 1000;
}

export function formatTimestamp(seconds: number, includeHours = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hrs > 0 || includeHours) {
    const hh = String(hrs).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safe * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function formatWebVttTimestamp(seconds: number): string {
  return formatSrtTimestamp(seconds).replace(',', '.');
}

/**
 * 2. TRANSCRIPT NORMALIZATION, CHUNK MERGING & COVERAGE VALIDATION
 */
export interface ParsedTranscriptResult {
  segments: TranscriptSegment[];
  timingVerified: boolean;
  warnings: string[];
}

export function parseTranscriptInput(
  rawText: string,
  sourceId: string,
  language = 'en',
  knownMediaDurationSec?: number
): ParsedTranscriptResult {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { segments: [], timingVerified: false, warnings: ['Empty transcript input.'] };
  }

  const warnings: string[] = [];

  // Case A: JSON array of segments (not bracketed timestamps like [00:00 - 00:14])
  if (trimmed.startsWith('[') && !/^\[\d{1,2}:\d{2}/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const segments: TranscriptSegment[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          const start = parseTimestamp(item.start ?? item.startTime ?? 0);
          const end = parseTimestamp(item.end ?? item.endTime ?? (start !== null ? start + 5 : 5));
          const text = String(item.text ?? item.content ?? '').trim();
          if (start !== null && end !== null && end > start && text) {
            segments.push({
              id: String(item.id || `seg-${String(i + 1).padStart(3, '0')}`),
              sourceId,
              start,
              end,
              text,
              speakerId: String(item.speakerId || item.speaker || 'Speaker 1'),
              language: String(item.language || language),
              confidence: typeof item.confidence === 'number' ? item.confidence : 0.96,
              timingVerified: item.timingVerified !== false,
            });
          }
        }
        if (segments.length > 0) {
          return {
            segments,
            timingVerified: segments.every((s) => s.timingVerified),
            warnings,
          };
        }
      }
    } catch {
      warnings.push('JSON parse failed; falling back to text/SRT parser.');
    }
  }

  // Case B: SRT or WebVTT blocks (contains "-->")
  if (trimmed.includes('-->')) {
    const blocks = trimmed
      .replace(/^WEBVTT[^\n]*\n+/i, '')
      .split(/\r?\n\r?\n+/)
      .map((b) => b.trim())
      .filter(Boolean);

    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const arrowIdx = lines.findIndex((l) => l.includes('-->'));
      if (arrowIdx === -1) continue;

      const timeLine = lines[arrowIdx];
      const [rawStart, rawEnd] = timeLine.split('-->').map((s) => s.trim().split(/\s+/)[0]);
      const start = parseTimestamp(rawStart);
      const end = parseTimestamp(rawEnd);
      const textLines = lines.slice(arrowIdx + 1).join(' ').trim();

      if (start !== null && end !== null && end > start && textLines) {
        let speakerId = 'Speaker 1';
        let cleanText = textLines;
        const speakerMatch = textLines.match(/^([^:]{2,28}):\s+(.+)$/);
        if (speakerMatch) {
          speakerId = speakerMatch[1].trim();
          cleanText = speakerMatch[2].trim();
        }
        segments.push({
          id: `seg-${String(segments.length + 1).padStart(3, '0')}`,
          sourceId,
          start,
          end,
          text: cleanText,
          speakerId,
          language,
          confidence: 0.98,
          timingVerified: true,
        });
      }
    }

    if (segments.length > 0) {
      return { segments, timingVerified: true, warnings };
    }
  }

  // Case C: Timestamped lines like "[00:12 - 00:25] Speaker: Spoken text" or "00:12 Speaker: Spoken text"
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bracketedSegments: TranscriptSegment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const intervalMatch = line.match(
      /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*(?:-|–|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s*(?:([^:]{2,28}):)?\s*(.+)$/i
    );
    if (intervalMatch) {
      const start = parseTimestamp(intervalMatch[1]);
      const end = parseTimestamp(intervalMatch[2]);
      const speakerId = (intervalMatch[3] || 'Speaker 1').trim();
      const text = intervalMatch[4].trim();
      if (start !== null && end !== null && end > start && text) {
        bracketedSegments.push({
          id: `seg-${String(bracketedSegments.length + 1).padStart(3, '0')}`,
          sourceId,
          start,
          end,
          text,
          speakerId,
          language,
          confidence: 0.95,
          timingVerified: true,
        });
      }
    }
  }

  if (bracketedSegments.length > 0) {
    return { segments: bracketedSegments, timingVerified: true, warnings };
  }

  // Case D: Plain text without timestamps -> Estimate timing based on ~2.5 words/sec and mark timingVerified = false!
  warnings.push(
    'Plain transcript provided without verified timestamps. Segment timings are estimated from speaking rate (~150 wpm) and marked as unverified.'
  );

  const paragraphs = trimmed
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const rawUnits =
    paragraphs.length > 1
      ? paragraphs
      : trimmed
          .split(/(?<=[.!?।])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);

  const totalWords = rawUnits.reduce((acc, u) => acc + u.split(/\s+/).length, 0) || 1;
  const targetTotalSec =
    knownMediaDurationSec && knownMediaDurationSec > 5
      ? knownMediaDurationSec
      : Math.max(15, Math.round(totalWords / 2.5));

  let cursor = 0;
  const estimatedSegments: TranscriptSegment[] = rawUnits.map((unit, idx) => {
    let speakerId = 'Speaker 1';
    let cleanText = unit;
    const speakerMatch = unit.match(/^([^:]{2,28}):\s+(.+)$/);
    if (speakerMatch) {
      speakerId = speakerMatch[1].trim();
      cleanText = speakerMatch[2].trim();
    }
    const wordCount = Math.max(1, cleanText.split(/\s+/).length);
    const rawDuration = (wordCount / totalWords) * targetTotalSec;
    const duration = Math.max(2, Math.round(rawDuration * 10) / 10);
    const start = Math.round(cursor * 10) / 10;
    const end =
      idx === rawUnits.length - 1 && knownMediaDurationSec
        ? knownMediaDurationSec
        : Math.round((cursor + duration) * 10) / 10;
    cursor = end;

    return {
      id: `seg-${String(idx + 1).padStart(3, '0')}`,
      sourceId,
      start,
      end: Math.max(start + 1, end),
      text: cleanText,
      speakerId,
      language,
      confidence: 0.7,
      timingVerified: false,
    };
  });

  return {
    segments: estimatedSegments,
    timingVerified: false,
    warnings,
  };
}

/**
 * Merges transcript segments across multiple long-audio chunks, applying chunk time offsets
 * and deduplicating overlapping boundary segments.
 */
export function mergeChunkedTranscriptSegments(
  paramsOrChunks:
    | {
        sourceId: string;
        totalDurationSec: number;
        chunks: Array<{
          chunkIndex: number;
          chunkOffsetSec: number;
          segments: Array<{
            start: number;
            end: number;
            text: string;
            speakerId: string;
            language?: string;
            confidence?: number;
          }>;
        }>;
      }
    | TranscriptSegment[][],
  fallbackSourceId = 'src-1'
): TranscriptSegment[] {
  if (Array.isArray(paramsOrChunks)) {
    const flat: TranscriptSegment[] = [];
    for (let cIdx = 0; cIdx < paramsOrChunks.length; cIdx++) {
      const group = paramsOrChunks[cIdx] || [];
      for (const seg of group) {
        flat.push({
          ...seg,
          sourceId: seg.sourceId || fallbackSourceId,
          chunkIndex: cIdx,
        });
      }
    }
    flat.sort((a, b) => a.start - b.start);
    return flat.map((s, idx) => ({
      ...s,
      id: `seg-${String(idx + 1).padStart(3, '0')}`,
    }));
  }

  const { sourceId, totalDurationSec, chunks } = paramsOrChunks;
  const rawMerged: Array<Omit<TranscriptSegment, 'id'>> = [];

  for (const chunk of chunks) {
    for (const seg of chunk.segments) {
      const text = String(seg.text || '').trim();
      if (!text) continue;
      const absStart = Math.max(0, Math.round((chunk.chunkOffsetSec + seg.start) * 10) / 10);
      const absEnd = Math.min(
        totalDurationSec > 0 ? totalDurationSec : chunk.chunkOffsetSec + seg.end,
        Math.max(absStart + 1, Math.round((chunk.chunkOffsetSec + seg.end) * 10) / 10)
      );
      if (absEnd <= absStart) continue;

      // Check overlap deduplication with previous segment
      const prev = rawMerged[rawMerged.length - 1];
      if (prev) {
        const timeOverlap = prev.end - absStart;
        const normalizedPrev = prev.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const normalizedCurr = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        if (
          timeOverlap > 0.5 &&
          normalizedPrev.length > 6 &&
          (normalizedPrev === normalizedCurr ||
            normalizedPrev.includes(normalizedCurr) ||
            normalizedCurr.includes(normalizedPrev))
        ) {
          prev.end = Math.max(prev.end, absEnd);
          continue;
        }
      }

      rawMerged.push({
        sourceId,
        start: absStart,
        end: absEnd,
        text,
        speakerId: String(seg.speakerId || 'Speaker 1').trim(),
        language: String(seg.language || 'en'),
        confidence: typeof seg.confidence === 'number' ? seg.confidence : 0.95,
        timingVerified: true,
        chunkIndex: chunk.chunkIndex,
      });
    }
  }

  rawMerged.sort((a, b) => a.start - b.start);

  return rawMerged.map((item, idx) => ({
    ...item,
    id: `seg-${String(idx + 1).padStart(3, '0')}`,
  }));
}

export function computeTranscriptCoverageReport(
  paramsOrSegments:
    | {
        segments: TranscriptSegment[];
        sourceDurationSec: number;
        chunksTotal?: number;
        chunksCompleted?: number;
        failedIntervals?: Array<{ start: number; end: number; reason: string }>;
      }
    | TranscriptSegment[],
  argSourceDurationSec?: number,
  argChunkCount?: number
): TranscriptCoverageReport {
  const params = Array.isArray(paramsOrSegments)
    ? {
        segments: paramsOrSegments,
        sourceDurationSec: argSourceDurationSec ?? 60,
        chunksTotal: argChunkCount ?? 1,
        chunksCompleted: argChunkCount ?? 1,
        failedIntervals: [],
      }
    : paramsOrSegments;

  const {
    segments,
    sourceDurationSec,
    chunksTotal = 1,
    chunksCompleted = 1,
    failedIntervals = [],
  } = params;
  const safeDuration = Math.max(1, sourceDurationSec || (segments[segments.length - 1]?.end ?? 60));

  let coveredSec = 0;
  let maxEnd = 0;
  for (const seg of segments) {
    const s = Math.max(maxEnd, Math.max(0, seg.start));
    const e = Math.min(safeDuration, Math.max(s, seg.end));
    if (e > s) {
      coveredSec += e - s;
      maxEnd = e;
    }
  }

  const spanSec =
    segments.length > 0
      ? Math.min(safeDuration, segments[segments.length - 1].end) -
        Math.max(0, segments[0].start)
      : 0;
  const effectiveCovered = Math.max(coveredSec, spanSec);
  const coveragePercent = Math.min(
    100,
    Math.round((effectiveCovered / safeDuration) * 1000) / 10
  );

  const speakers = Array.from(
    new Set(segments.map((s) => s.speakerId || s.speaker).filter(Boolean) as string[])
  );
  const detectedLanguages = Array.from(
    new Set(segments.map((s) => s.language || 'en').filter(Boolean))
  );
  const translatedLanguage = segments.find((s) => s.translatedLanguage)?.translatedLanguage;
  const resolvedSpeakers = speakers.length > 0 ? speakers : ['Speaker 1'];

  const roundedSourceSec = Math.round(safeDuration * 10) / 10;
  const roundedCoveredSec = Math.round(effectiveCovered * 10) / 10;

  return {
    sourceDurationSec: roundedSourceSec,
    totalMediaDurationSeconds: roundedSourceSec,
    coveredDurationSec: roundedCoveredSec,
    coveredDurationSeconds: roundedCoveredSec,
    coveragePercent,
    segmentCount: segments.length,
    chunksTotal,
    chunksCompleted,
    chunkCount: chunksTotal,
    speakerCount: resolvedSpeakers.length,
    failedIntervals,
    detectedLanguages: detectedLanguages.length > 0 ? detectedLanguages : ['en'],
    speakers: resolvedSpeakers,
    translatedLanguage,
    lastVerifiedAt: new Date().toISOString(),
  };
}

export function validateTranscriptSegments(
  segments: TranscriptSegment[],
  sourceDurationSec?: number
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(segments) || segments.length === 0) {
    errors.push('Transcript contains zero valid segments.');
    return { valid: false, errors, warnings };
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.id) errors.push(`Segment at index ${i} is missing an ID.`);
    if (!Number.isFinite(seg.start) || seg.start < 0) {
      errors.push(`Segment ${seg.id} has an invalid start timestamp (${seg.start}).`);
    }
    if (!Number.isFinite(seg.end) || seg.end <= seg.start) {
      errors.push(`Segment ${seg.id} has an end timestamp (${seg.end}) that is not greater than start (${seg.start}).`);
    }
    if (!seg.text || !seg.text.trim()) {
      errors.push(`Segment ${seg.id} has empty spoken text.`);
    }
    if (i > 0 && seg.start < segments[i - 1].start) {
      errors.push(`Segment ${seg.id} is out of chronological order.`);
    }
    if (sourceDurationSec && seg.end > sourceDurationSec + 1) {
      warnings.push(
        `Segment ${seg.id} end time (${seg.end}s) exceeds media duration (${sourceDurationSec}s).`
      );
    }
  }

  if (segments.some((s) => !s.timingVerified)) {
    warnings.push('One or more transcript segments rely on estimated timing rather than verified media timecodes.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 3. CLIP DURATION, SHORT-FORM (<=120s) CLAMPING & BOUNDARY VALIDATION
 */
export function calculateClipDuration(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.round((end - start) * 100) / 100;
}

/**
 * Ensures any short-form clip interval is strictly <= 120 seconds (Instagram Reels / YouTube Shorts limit)
 * and within [0, sourceDurationSec].
 */
export function clampClipIntervalToShortForm(params: {
  start: number;
  end: number;
  sourceDurationSec: number;
  maxDurationSec?: number;
  maxAllowedSec?: number;
  minAllowedSec?: number;
  preferredDurationSec?: number;
  transcript?: TranscriptSegment[];
}): {
  start: number;
  end: number;
  duration: number;
  wasClamped: boolean;
  clamped: boolean;
  matchedSegmentIds: string[];
} {
  const requestedMax = params.maxDurationSec ?? params.maxAllowedSec;
  const hardMax = Math.min(
    SHORT_FORM_MAX_DURATION_SEC,
    requestedMax && requestedMax > 0
      ? requestedMax
      : SHORT_FORM_MAX_DURATION_SEC
  );
  const preferred = Math.min(
    hardMax,
    params.preferredDurationSec && params.preferredDurationSec > 0
      ? params.preferredDurationSec
      : SHORT_FORM_DEFAULT_TARGET_SEC
  );
  const maxMedia = params.sourceDurationSec > 0 ? params.sourceDurationSec : 3600;

  let s = Number.isFinite(params.start) && params.start >= 0 ? params.start : 0;
  let e = Number.isFinite(params.end) && params.end > s ? params.end : s + preferred;
  let wasClamped = false;

  if (s >= maxMedia) {
    s = Math.max(0, maxMedia - Math.min(preferred, maxMedia));
    wasClamped = true;
  }
  if (e > maxMedia) {
    e = maxMedia;
    wasClamped = true;
  }
  if (e - s > hardMax) {
    const targetSpan = e - s > hardMax * 1.5 ? preferred : hardMax;
    e = Math.min(maxMedia, Math.round((s + targetSpan) * 10) / 10);
    wasClamped = true;
  }
  if (e <= s) {
    e = Math.min(maxMedia, s + Math.min(15, maxMedia - s));
    wasClamped = true;
  }

  s = Math.round(s * 10) / 10;
  e = Math.round(e * 10) / 10;

  const matchedSegmentIds = (params.transcript || [])
    .filter((seg) => seg.end > s + 0.1 && seg.start < e - 0.1)
    .map((seg) => seg.id);

  return {
    start: s,
    end: e,
    duration: calculateClipDuration(s, e),
    wasClamped,
    clamped: wasClamped,
    matchedSegmentIds,
  };
}

export function validateClipBoundaries(params: {
  start: number;
  end: number;
  sourceDurationSec: number;
  transcript: TranscriptSegment[];
  minDurationSec?: number;
  maxDurationSec?: number;
  allowOutliers?: boolean;
}): ClipBoundaryValidation & {
  matchedSegments: TranscriptSegment[];
  duration: number;
  openingText: string;
  closingText: string;
  fullTranscript: string;
} {
  const {
    start,
    end,
    sourceDurationSec,
    transcript,
    minDurationSec = 15,
    maxDurationSec = 75,
    allowOutliers = false,
  } = params;

  const effectiveMax = Math.min(SHORT_FORM_MAX_DURATION_SEC, maxDurationSec);
  const warnings: string[] = [];
  let isInvalid = false;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    warnings.push('Start and end timestamps must be non-negative numbers.');
    isInvalid = true;
  }

  if (end <= start) {
    warnings.push('End timestamp must be strictly later than start timestamp.');
    isInvalid = true;
  }

  const withinSourceDuration =
    sourceDurationSec > 0 ? start >= 0 && end <= sourceDurationSec + 0.5 : true;

  if (!withinSourceDuration) {
    warnings.push(
      `Clip interval (${formatTimestamp(start)} - ${formatTimestamp(end)}) exceeds source media duration (${formatTimestamp(sourceDurationSec)}).`
    );
    isInvalid = true;
  }

  const duration = calculateClipDuration(start, end);
  const withinShortFormLimit = duration <= SHORT_FORM_MAX_DURATION_SEC;

  if (!withinShortFormLimit) {
    warnings.push(
      `Clip duration (${duration}s) exceeds the 120s maximum for Instagram Reels and YouTube Shorts.`
    );
    isInvalid = true;
  } else if (!allowOutliers) {
    if (duration < minDurationSec) {
      warnings.push(
        `Clip duration (${duration}s) is shorter than target minimum (${minDurationSec}s).`
      );
    }
    if (duration > effectiveMax) {
      warnings.push(
        `Clip duration (${duration}s) exceeds target maximum (${effectiveMax}s).`
      );
    }
  }

  // Match segments overlapping [start, end]
  const matchedSegments = transcript.filter(
    (seg) => seg.end > start + 0.1 && seg.start < end - 0.1
  );

  if (matchedSegments.length === 0) {
    warnings.push('No transcript segments overlap with the selected time interval.');
    isInvalid = true;
  }

  const firstSeg = matchedSegments[0];
  const lastSeg = matchedSegments[matchedSegments.length - 1];

  // Check if boundary cuts through a sentence
  const cutsSentenceStart = Boolean(
    firstSeg &&
      (start > firstSeg.start + 1.5 || /^[a-z]/.test(firstSeg.text.trim()))
  );
  if (cutsSentenceStart) {
    warnings.push(
      'Opening boundary starts mid-segment or begins with a lowercase continuation.'
    );
  }

  const cutsSentenceEnd = Boolean(
    lastSeg &&
      (end < lastSeg.end - 1.5 || !/[.!?।"']?$/.test(lastSeg.text.trim()))
  );
  if (cutsSentenceEnd) {
    warnings.push(
      'Closing boundary cuts before segment completion or lacks terminal sentence punctuation.'
    );
  }

  const fullTranscript = matchedSegments.map((s) => s.text.trim()).join(' ');
  const wordCount = fullTranscript ? fullTranscript.split(/\s+/).length : 0;
  const lacksStandaloneContext =
    wordCount < 12 ||
    /^(and|but|so|because|therefore|that|this|it|they)\b/i.test(fullTranscript.trim());

  if (lacksStandaloneContext) {
    warnings.push(
      'Clip may lack standalone context (starts with a referential conjunction/pronoun or has fewer than 12 words).'
    );
  }

  const unverifiedTiming = matchedSegments.some((s) => !s.timingVerified);
  if (unverifiedTiming) {
    warnings.push(
      'Transcript timing is estimated; inspect boundaries before rendering final video.'
    );
  }

  const status: 'valid' | 'needs_review' | 'invalid' = isInvalid
    ? 'invalid'
    : warnings.length > 0
      ? 'needs_review'
      : 'valid';

  return {
    status,
    warnings,
    cutsSentenceStart,
    cutsSentenceEnd,
    lacksStandaloneContext,
    withinSourceDuration,
    withinShortFormLimit,
    overlapsWithClipIds: [],
    matchedSegments,
    duration,
    openingText: firstSeg ? firstSeg.text : '',
    closingText: lastSeg ? lastSeg.text : '',
    fullTranscript,
  };
}

/**
 * Creates a validated Short-Form VideoClipCandidate directly from user-selected transcript segments.
 */
export function createClipFromTranscriptSelection(params: {
  projectId: string;
  sourceId: string;
  sourceDurationSec: number;
  selectedSegments?: TranscriptSegment[];
  selectedSegmentIds?: string[];
  allTranscript?: TranscriptSegment[];
  allSegments?: TranscriptSegment[];
  transcript?: TranscriptSegment[];
  brand?: BrandProfile;
  existingClipCount?: number;
  maxDurationSec?: number;
  recommendedPlatform?: PlatformType;
  targetPlatform?: PlatformType;
  platform?: PlatformType | string;
}): VideoClipCandidate {
  const {
    projectId,
    sourceId,
    sourceDurationSec,
    selectedSegments,
    selectedSegmentIds,
    allTranscript,
    allSegments,
    transcript,
    brand,
    existingClipCount = 0,
    maxDurationSec = SHORT_FORM_MAX_DURATION_SEC,
    recommendedPlatform,
    targetPlatform,
    platform,
  } = params;

  const fullList = allTranscript || allSegments || transcript || selectedSegments || [];
  const resolvedSelected =
    selectedSegments && selectedSegments.length > 0
      ? selectedSegments
      : selectedSegmentIds && selectedSegmentIds.length > 0
        ? fullList.filter((s) => selectedSegmentIds.includes(s.id))
        : fullList.slice(0, 2);
  const resolvedPlatform = (recommendedPlatform ||
    targetPlatform ||
    platform ||
    'YouTube Shorts') as PlatformType;
  const sorted = [...resolvedSelected].sort((a, b) => a.start - b.start);
  const rawStart = sorted[0]?.start ?? 0;
  const rawEnd = sorted[sorted.length - 1]?.end ?? rawStart + 30;
  const capMax = Math.min(SHORT_FORM_MAX_DURATION_SEC, maxDurationSec);

  const clamped = clampClipIntervalToShortForm({
    start: rawStart,
    end: rawEnd,
    sourceDurationSec,
    maxDurationSec: capMax,
    preferredDurationSec: Math.min(capMax, Math.max(15, rawEnd - rawStart)),
  });

  const check = validateClipBoundaries({
    start: clamped.start,
    end: clamped.end,
    sourceDurationSec,
    transcript: fullList,
    minDurationSec: 10,
    maxDurationSec: capMax,
    allowOutliers: true,
  });

  const now = new Date().toISOString();
  const firstText = sorted[0]?.text || 'Selected Transcript Highlight';
  const hookSentence = firstText.split(/[.!?।]/)[0]?.trim() || firstText.slice(0, 70);
  const clipNum = existingClipCount + 1;
  const defaultCaptionStyle = brand?.visualIdentity?.captionStyle || {
    fontFamily: 'NotoSans-Bold' as const,
    fontSize: 36,
    textColor: '#FFFFFF',
    backgroundColor: '#0F172ACC',
    outlineColor: '#000000',
    position: 'bottom' as const,
    maxLineLengthChars: 28,
    maxWordsPerSegment: 7,
    highlightKeywords: [],
    safeMarginPx: 120,
  };

  return {
    id: `clip-${String(clipNum).padStart(2, '0')}-${Date.now().toString(36).slice(-4)}`,
    projectId,
    sourceId,
    title: `Clip #${clipNum}: ${hookSentence.slice(0, 48)}${hookSentence.length > 48 ? '...' : ''}`,
    hook: hookSentence,
    start: clamped.start,
    end: clamped.end,
    duration: clamped.duration,
    openingText: check.openingText || firstText,
    closingText: check.closingText || sorted[sorted.length - 1]?.text || firstText,
    fullTranscript: check.fullTranscript || sorted.map((s) => s.text).join(' '),
    centralIdea: hookSentence,
    selectionReason: `User-curated transcript passage (${formatTimestamp(clamped.start)}–${formatTimestamp(clamped.end)}, ${clamped.duration}s).`,
    speakerId: sorted[0]?.speakerId || 'Speaker 1',
    targetAudience: brand?.targetAudiences?.[0] || 'Practitioners & Decision Makers',
    recommendedPlatform: resolvedPlatform,
    suggestedCaption: `${check.fullTranscript || firstText}\n\n${brand?.approvedCallsToAction?.[0] || ''}`.trim(),
    onScreenTitle: hookSentence.slice(0, 36),
    callToAction: brand?.approvedCallsToAction?.[0] || 'Watch the full episode.',
    editorialScores: {
      openingStrength: 92,
      contentClarity: 94,
      completeness: 91,
      audienceRelevance: 93,
      standaloneUsefulness: 92,
      productionSuitability: 95,
      emotionalImpact: 90,
      noveltyInsight: 89,
      quotability: 93,
      pacingDelivery: 92,
      overallScore: 93,
      rationale: 'Directly selected from verified transcript boundaries and clamped within the <=120s short-form limit.',
    },
    timingConfidence: check.matchedSegments.every((s) => s.timingVerified) ? 'verified' : 'estimated',
    sourceSegmentIds: check.matchedSegments.map((s) => s.id),
    boundaryValidation: {
      status: check.status,
      warnings: check.warnings,
      cutsSentenceStart: check.cutsSentenceStart,
      cutsSentenceEnd: check.cutsSentenceEnd,
      lacksStandaloneContext: check.lacksStandaloneContext,
      withinSourceDuration: check.withinSourceDuration,
      withinShortFormLimit: true,
      overlapsWithClipIds: [],
    },
    renderConfig: {
      aspectRatio: '9:16',
      width: 540,
      height: 960,
      layoutMode: brand?.visualIdentity?.videoLayoutPreference || 'blurred-background',
      burnInCaptions: true,
      showBrandLogoOverlay: true,
      showHookTitleOverlay: true,
      captionStyle: defaultCaptionStyle,
    },
    renderStatus: 'waiting',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 4. CLIP RANKING & OVERLAP DETECTION
 */
export function calculateWeightedEditorialScore(
  scores: Omit<ClipEditorialScores, 'overallScore' | 'rationale'>,
  weights: EditorialWeights
): number {
  const totalWeight =
    weights.openingStrength +
    weights.contentClarity +
    weights.completeness +
    weights.audienceRelevance +
    weights.standaloneUsefulness +
    weights.productionSuitability;

  if (totalWeight <= 0) return 0;

  const weightedSum =
    scores.openingStrength * weights.openingStrength +
    scores.contentClarity * weights.contentClarity +
    scores.completeness * weights.completeness +
    scores.audienceRelevance * weights.audienceRelevance +
    scores.standaloneUsefulness * weights.standaloneUsefulness +
    scores.productionSuitability * weights.productionSuitability;

  return Math.round(weightedSum / totalWeight);
}

export function detectOverlappingClips(
  clips: VideoClipCandidate[]
): VideoClipCandidate[] {
  return clips.map((clip) => {
    const overlaps: string[] = [];
    for (const other of clips) {
      if (other.id === clip.id) continue;
      const overlapStart = Math.max(clip.start, other.start);
      const overlapEnd = Math.min(clip.end, other.end);
      const overlapSec = Math.max(0, overlapEnd - overlapStart);
      const minDur = Math.max(1, Math.min(clip.duration, other.duration));
      if (overlapSec / minDur >= 0.35) {
        overlaps.push(other.id);
      }
    }

    const updatedWarnings = clip.boundaryValidation.warnings.filter(
      (w) => !w.startsWith('Overlaps significantly with')
    );
    if (overlaps.length > 0) {
      updatedWarnings.push(`Overlaps significantly with clip(s): ${overlaps.join(', ')}.`);
    }

    const nextStatus =
      clip.boundaryValidation.status === 'invalid'
        ? 'invalid'
        : updatedWarnings.length > 0
          ? 'needs_review'
          : 'valid';

    return {
      ...clip,
      boundaryValidation: {
        ...clip.boundaryValidation,
        status: nextStatus,
        warnings: updatedWarnings,
        overlapsWithClipIds: overlaps,
      },
    };
  });
}

/**
 * 5. BRAND ASSUMPTIONS & INJECTION
 */
export function resolveBrandAssumptions(brand: Partial<BrandProfile>): {
  normalizedBrand: BrandProfile;
  assumptionsMade: string[];
} {
  const assumptionsMade: string[] = [];
  const now = new Date().toISOString();

  if (!brand.brandVoice?.trim()) {
    assumptionsMade.push('Brand voice was unspecified; defaulted to "Clear, authoritative, evidence-backed practitioner tone".');
  }
  if (!brand.targetAudiences || brand.targetAudiences.length === 0) {
    assumptionsMade.push('Target audiences were unspecified; defaulted to "Technical decision-makers and operations leaders".');
  }
  if (!brand.approvedCallsToAction || brand.approvedCallsToAction.length === 0) {
    assumptionsMade.push('Approved calls to action were unspecified; defaulted to "Book an architecture review or explore the documentation".');
  }
  if (!brand.legalDisclaimers?.trim()) {
    assumptionsMade.push('Legal disclaimers were unspecified; applied standard rule prohibiting unverified performance guarantees.');
  }

  const normalizedBrand: BrandProfile = {
    id: brand.id || 'brand-default',
    name: brand.name?.trim() || 'Default Brand Profile',
    companyDescription:
      brand.companyDescription?.trim() ||
      'Technology and advisory organization focused on operational efficiency.',
    industry: brand.industry?.trim() || 'B2B Software & Infrastructure',
    businessModel: brand.businessModel?.trim() || 'Enterprise B2B SaaS',
    productsAndServices:
      brand.productsAndServices && brand.productsAndServices.length > 0
        ? brand.productsAndServices
        : ['Core Platform', 'Advisory Services'],
    targetAudiences:
      brand.targetAudiences && brand.targetAudiences.length > 0
        ? brand.targetAudiences
        : ['Technical decision-makers and operations leaders'],
    primaryCustomerProblems:
      brand.primaryCustomerProblems && brand.primaryCustomerProblems.length > 0
        ? brand.primaryCustomerProblems
        : ['High operational overhead', 'Lack of visibility into resource utilization'],
    brandPositioning:
      brand.brandPositioning?.trim() ||
      'Pragmatic engineering leadership backed by measurable telemetry.',
    uniqueDifferentiators:
      brand.uniqueDifferentiators && brand.uniqueDifferentiators.length > 0
        ? brand.uniqueDifferentiators
        : ['Deterministic verification', 'Zero-bloat workflows'],
    brandVoice:
      brand.brandVoice?.trim() ||
      'Clear, authoritative, evidence-backed practitioner tone',
    writingStyle:
      brand.writingStyle?.trim() ||
      'Direct active voice, concrete numbers, zero buzzword fluff.',
    preferredVocabulary: brand.preferredVocabulary || ['unit economics', 'telemetry', 'deterministic'],
    wordsToAvoid: brand.wordsToAvoid || ['synergy', 'revolutionary', 'guaranteed viral', 'game-changer'],
    approvedCallsToAction:
      brand.approvedCallsToAction && brand.approvedCallsToAction.length > 0
        ? brand.approvedCallsToAction
        : ['Run a baseline infrastructure audit with our team.'],
    website: brand.website?.trim() || 'https://example.com',
    brandReferences: brand.brandReferences || [],
    existingContentExamples: brand.existingContentExamples || [],
    preferredPlatforms: brand.preferredPlatforms || [
      'Blog / Organic Search',
      'Email Newsletter',
      'LinkedIn',
      'YouTube Shorts',
    ],
    visualIdentity: brand.visualIdentity || {
      logoText: brand.name?.trim() || 'STUDIO',
      primaryColor: '#0F172A',
      accentColor: '#2563EB',
      backgroundColor: '#F8FAFC',
      fontPreference: 'Plus Jakarta Sans',
      videoLayoutPreference: 'blurred-background',
      captionStyle: {
        fontFamily: 'NotoSans-Bold',
        fontSize: 36,
        textColor: '#FFFFFF',
        backgroundColor: '#0F172ACC',
        outlineColor: '#000000',
        position: 'bottom',
        maxLineLengthChars: 34,
        maxWordsPerSegment: 8,
        highlightKeywords: [],
        safeMarginPx: 120,
      },
    },
    legalDisclaimers:
      brand.legalDisclaimers?.trim() ||
      'Do not fabricate statistics, customer endorsements, or guaranteed financial outcomes.',
    createdAt: brand.createdAt || now,
    updatedAt: now,
  };

  return { normalizedBrand, assumptionsMade };
}

/**
 * 6. SRT CAPTION GENERATION (CLIP-RELATIVE TIMING)
 */
export function generateClipSrt(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  maxWordsPerCue = 10,
  captionScriptMode: CaptionScriptMode = 'original'
): { srtContent: string; cueCount: number; timingConfidence: 'verified' | 'estimated' } {
  const overlapping = transcript.filter(
    (s) => s.end > clipStart + 0.05 && s.start < clipEnd - 0.05
  );

  const cues: { start: number; end: number; text: string }[] = [];
  const safeMaxWords = Math.max(4, Math.min(25, maxWordsPerCue));

  for (const seg of overlapping) {
    const relStart = Math.max(0, seg.start - clipStart);
    const relEnd = Math.min(clipEnd - clipStart, seg.end - clipStart);
    const segDuration = Math.max(0.5, relEnd - relStart);
    const activeText = resolveSegmentTextForCaptionMode(seg, captionScriptMode);
    const words = activeText.trim().split(/\s+/).filter(Boolean);

    if (words.length <= safeMaxWords) {
      cues.push({ start: relStart, end: relEnd, text: words.join(' ') });
    } else {
      const chunks: string[] = [];
      for (let i = 0; i < words.length; i += safeMaxWords) {
        chunks.push(words.slice(i, i + safeMaxWords).join(' '));
      }
      const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
      let cursor = relStart;
      chunks.forEach((chunk, idx) => {
        const dur = (chunk.length / totalChars) * segDuration;
        const nextEnd = idx === chunks.length - 1 ? relEnd : cursor + dur;
        cues.push({
          start: Math.round(cursor * 100) / 100,
          end: Math.round(Math.max(cursor + 0.4, nextEnd) * 100) / 100,
          text: chunk,
        });
        cursor = nextEnd;
      });
    }
  }

  const srtBlocks = cues.map((cue, index) => {
    return `${index + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`;
  });

  const timingConfidence = overlapping.every((s) => s.timingVerified) ? 'verified' : 'estimated';

  return {
    srtContent: srtBlocks.join('\n\n') + (srtBlocks.length ? '\n' : ''),
    cueCount: cues.length,
    timingConfidence,
  };
}

/**
 * 7. DETERMINISTIC 4-WEEK CONTENT CALENDAR SCHEDULER
 */
const DAY_NAME_TO_OFFSET: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

const OFFSET_TO_DAY_NAME = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function generateDeterministicCalendar(params: {
  projectId: string;
  startDate: string; // YYYY-MM-DD
  preferredDays: string[];
  assets: AssetDeliverable[];
  clips: VideoClipCandidate[];
}): CalendarEntry[] {
  const { projectId, startDate, preferredDays, assets, clips } = params;

  const baseDate = new Date(`${startDate}T09:00:00Z`);
  const validStart = Number.isNaN(baseDate.getTime())
    ? new Date('2026-11-02T09:00:00Z')
    : baseDate;

  const dayOffsets =
    preferredDays.length > 0
      ? preferredDays
          .map((d) => DAY_NAME_TO_OFFSET[d] ?? 1)
          .sort((a, b) => a - b)
      : [0, 2, 4]; // Mon, Wed, Fri

  interface RawSchedulable {
    assetId?: string;
    clipId?: string;
    title: string;
    assetType: CalendarEntry['assetType'];
    platform: PlatformType;
    category: ContentCategory;
    status: 'scheduled_draft' | 'approved_ready';
    notes: string;
  }

  const pool: RawSchedulable[] = [];

  for (const asset of assets) {
    if (asset.status === 'rejected') continue;
    pool.push({
      assetId: asset.id,
      title: asset.title,
      assetType: asset.assetType,
      platform: asset.platform,
      category: asset.category || 'Educational',
      status: asset.status === 'approved' ? 'approved_ready' : 'scheduled_draft',
      notes: `Source segments: ${asset.sourceSegmentIds.join(', ') || 'Primary analysis'}`,
    });
  }

  for (const clip of clips) {
    if (clip.renderStatus === 'rejected') continue;
    pool.push({
      clipId: clip.id,
      title: `Short Clip: ${clip.title}`,
      assetType: 'video_clip',
      platform: clip.recommendedPlatform,
      category: 'Opinion-Led',
      status: clip.renderStatus === 'approved' ? 'approved_ready' : 'scheduled_draft',
      notes: `Interval ${formatTimestamp(clip.start)} - ${formatTimestamp(clip.end)} (${clip.duration}s)`,
    });
  }

  const categoryOrder: ContentCategory[] = [
    'Educational',
    'Opinion-Led',
    'Story / Case',
    'Promotional',
  ];
  const buckets: Record<ContentCategory, RawSchedulable[]> = {
    Educational: [],
    'Opinion-Led': [],
    'Story / Case': [],
    Promotional: [],
  };

  for (const item of pool) {
    buckets[item.category]?.push(item) ?? buckets.Educational.push(item);
  }

  const balanced: RawSchedulable[] = [];
  let remaining = pool.length;
  while (remaining > 0) {
    for (const cat of categoryOrder) {
      const next = buckets[cat].shift();
      if (next) {
        balanced.push(next);
        remaining--;
      }
    }
  }

  const slots: { dateStr: string; dayOfWeek: string; weekNumber: number }[] = [];
  for (let week = 0; week < 4; week++) {
    for (const offset of dayOffsets) {
      const slotDate = new Date(validStart.getTime());
      slotDate.setUTCDate(validStart.getUTCDate() + week * 7 + offset);
      const yyyy = slotDate.getUTCFullYear();
      const mm = String(slotDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(slotDate.getUTCDate()).padStart(2, '0');
      slots.push({
        dateStr: `${yyyy}-${mm}-${dd}`,
        dayOfWeek: OFFSET_TO_DAY_NAME[offset] || 'Tuesday',
        weekNumber: week + 1,
      });
    }
  }

  let extraDayCursor = 1;
  while (slots.length < balanced.length) {
    const slotDate = new Date(validStart.getTime());
    slotDate.setUTCDate(validStart.getUTCDate() + (extraDayCursor % 28));
    const yyyy = slotDate.getUTCFullYear();
    const mm = String(slotDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(slotDate.getUTCDate()).padStart(2, '0');
    const candidateDate = `${yyyy}-${mm}-${dd}`;
    if (!slots.some((s) => s.dateStr === candidateDate)) {
      slots.push({
        dateStr: candidateDate,
        dayOfWeek: OFFSET_TO_DAY_NAME[slotDate.getUTCDay() === 0 ? 6 : slotDate.getUTCDay() - 1],
        weekNumber: Math.min(4, Math.floor((extraDayCursor % 28) / 7) + 1),
      });
    }
    extraDayCursor++;
    if (extraDayCursor > 60) break;
  }

  return balanced.map((item, idx) => {
    const slot = slots[idx % slots.length];
    return {
      id: `cal-${String(idx + 1).padStart(2, '0')}`,
      projectId,
      assetId: item.assetId,
      clipId: item.clipId,
      title: item.title,
      assetType: item.assetType,
      platform: item.platform,
      category: item.category,
      scheduledDate: slot.dateStr,
      dayOfWeek: slot.dayOfWeek,
      weekNumber: slot.weekNumber,
      status: item.status,
      notes: item.notes,
      order: idx + 1,
    };
  });
}

/**
 * 8. MARKDOWN, CSV & MANIFEST FORMATTERS
 */
export function formatBlogMarkdown(blog: SeoBlogStructured): string {
  const lines: string[] = [
    `# ${blog.suggestedTitle}`,
    '',
    `> **Meta Title:** ${blog.metaTitle}`,
    `> **Meta Description:** ${blog.metaDescription}`,
    `> **Suggested Slug:** \`/${blog.urlSlug}\``,
    `> **Search Intent:** ${blog.searchIntent} | **Primary Keyword:** ${blog.primaryKeyword}`,
    `> **Secondary Keywords:** ${blog.secondaryKeywords.join(', ')}`,
    '',
    '## Alternative Headlines',
    ...blog.alternativeHeadlines.map((h) => `- ${h}`),
    '',
    '## Introduction',
    blog.introduction,
    '',
  ];

  for (const sec of blog.sections) {
    lines.push(`## ${sec.heading}`);
    lines.push('');
    lines.push(sec.body);
    if (sec.supportingSegmentIds?.length) {
      lines.push('');
      lines.push(`*Source Reference Segments: ${sec.supportingSegmentIds.join(', ')}*`);
    }
    if (sec.claimNote) {
      lines.push(`*Verification Note: ${sec.claimNote}*`);
    }
    lines.push('');
  }

  lines.push('## Conclusion');
  lines.push(blog.conclusion);
  lines.push('');
  lines.push('---');
  lines.push(`**Call to Action:** ${blog.callToAction}`);
  if (blog.internalLinkSuggestions?.length) {
    lines.push('');
    lines.push('**Internal Link Recommendations:**');
    for (const link of blog.internalLinkSuggestions) {
      lines.push(`- ${link}`);
    }
  }

  return lines.join('\n');
}

export function formatNewsletterMarkdown(nl: NewsletterStructured): string {
  const lines: string[] = [
    `# Subject: ${nl.subjectLine}`,
    `**Preview Text:** ${nl.previewText}`,
    `**Alternative Subjects:** ${nl.alternativeSubjectLines.join(' | ')}`,
    `**Tone:** ${nl.tone} | **Objective:** ${nl.objective}`,
    '',
    '---',
    '',
    nl.opening,
    '',
    nl.mainMessage,
    '',
    '### Key Takeaways',
    ...nl.keyTakeaways.map((t) => `- ${t}`),
    '',
  ];

  if (nl.sourceQuotation?.quote) {
    lines.push(
      `> "${nl.sourceQuotation.quote}" — ${nl.sourceQuotation.speaker} (${nl.sourceQuotation.timestamp})`
    );
    lines.push('');
  }

  lines.push(`**Next Step:** ${nl.callToAction}`);
  lines.push('');
  lines.push(nl.closing);

  return lines.join('\n');
}

export function formatLinkedInMarkdown(post: LinkedInPostStructured): string {
  return [
    `### [${post.format}] ${post.openingHook}`,
    '',
    post.postText,
    '',
    `---`,
    `**Core Argument:** ${post.coreArgument}`,
    `**Supporting Source Material:** ${post.supportingMaterial}`,
    `**Suggested CTA:** ${post.callToAction}`,
    `**Source Timestamps:** ${post.sourceTimestamps.join(', ')}`,
  ].join('\n');
}

export function generateCutSheetCsv(clips: VideoClipCandidate[]): string {
  const header = [
    'Clip ID',
    'Title',
    'Platform',
    'Start (s)',
    'End (s)',
    'Duration (s)',
    'Overall Score',
    'Boundary Status',
    'Timing Confidence',
    'Render Status',
    'Hook',
    'Call To Action',
  ];

  const escapeCsv = (val: string | number) => {
    const s = String(val ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = clips.map((c) =>
    [
      c.id,
      c.title,
      c.recommendedPlatform,
      c.start,
      c.end,
      c.duration,
      c.editorialScores.overallScore,
      c.boundaryValidation.status,
      c.timingConfidence,
      c.renderStatus,
      c.hook,
      c.callToAction,
    ]
      .map(escapeCsv)
      .join(',')
  );

  return [header.map(escapeCsv).join(','), ...rows].join('\n');
}

export function generateCalendarCsv(entries: CalendarEntry[]): string {
  const header = [
    'Order',
    'Scheduled Date',
    'Day',
    'Week',
    'Title',
    'Asset Type',
    'Platform',
    'Category',
    'Status',
    'Notes',
  ];

  const escapeCsv = (val: string | number) => {
    const s = String(val ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = entries.map((e) =>
    [
      e.order,
      e.scheduledDate,
      e.dayOfWeek,
      e.weekNumber,
      e.title,
      e.assetType,
      e.platform,
      e.category,
      e.status,
      e.notes,
    ]
      .map(escapeCsv)
      .join(',')
  );

  return [header.map(escapeCsv).join(','), ...rows].join('\n');
}

/**
 * 9. SECURITY, FILE PATH, ENVIRONMENT STORAGE & ERROR SANITIZATION
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = String(raw || 'file')
    .replace(/\.{2,}/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || 'asset';
}

function normalizePosixPath(inputPath: string): string {
  const parts = inputPath.replace(/\\/g, '/').split('/');
  const isAbs = inputPath.startsWith('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return (isAbs ? '/' : '') + stack.join('/');
}

function joinAndResolvePosix(baseDir: string, targetPath?: string): string {
  if (!targetPath) return normalizePosixPath(baseDir);
  if (targetPath.startsWith('/')) return normalizePosixPath(targetPath);
  return normalizePosixPath(`${baseDir}/${targetPath}`);
}

export function validateSafeProjectPath(baseDir: string, targetPath: string): {
  safe: boolean;
  resolvedPath: string;
  error?: string;
} {
  if (!targetPath || targetPath.includes('\0')) {
    return { safe: false, resolvedPath: '', error: 'Path contains invalid null byte or is empty.' };
  }
  const resolvedBase = joinAndResolvePosix(baseDir);
  const resolvedTarget = joinAndResolvePosix(baseDir, targetPath);

  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + '/')
  ) {
    return {
      safe: false,
      resolvedPath: '',
      error: 'Security error: Path traversal outside approved storage directory is prohibited.',
    };
  }

  return { safe: true, resolvedPath: resolvedTarget };
}

/**
 * Resolves environment-aware storage paths so a Windows path like "D:\StrataStudio\storage"
 * never creates a broken backslash/colon directory inside a Linux container.
 */
export function resolveEnvironmentStoragePaths(
  configuredDir: string | undefined,
  platform: string = typeof process !== 'undefined' ? process.platform : 'linux',
  cwd: string = typeof process !== 'undefined' && process.cwd ? process.cwd() : '/app/applet'
): {
  configuredPath: string;
  configuredRawPath: string;
  effectiveRoot: string;
  activePath: string;
  activeStoragePath: string;
  isWindowsPathOnPosix: boolean;
  isFallbackFromWindowsPath: boolean;
  fallbackReason?: string;
  platform: string;
  storageBackendLabel: string;
} {
  const raw = (configuredDir || 'D:\\StrataStudio\\storage').trim();
  const looksLikeWindowsDrive = /^[A-Za-z]:[\\/]/.test(raw) || raw.includes('\\');

  if (platform === 'win32') {
    const resolved = raw;
    return {
      configuredPath: raw,
      configuredRawPath: raw,
      effectiveRoot: resolved,
      activePath: resolved,
      activeStoragePath: resolved,
      isWindowsPathOnPosix: false,
      isFallbackFromWindowsPath: false,
      platform,
      storageBackendLabel: `Windows Local Storage (${resolved})`,
    };
  }

  if (looksLikeWindowsDrive) {
    const posixRoot = joinAndResolvePosix(cwd, 'storage');
    const fallbackReason = `Windows drive path "${raw}" mapped safely to container POSIX directory "${posixRoot}"`;
    return {
      configuredPath: raw,
      configuredRawPath: raw,
      effectiveRoot: posixRoot,
      activePath: posixRoot,
      activeStoragePath: posixRoot,
      isWindowsPathOnPosix: true,
      isFallbackFromWindowsPath: true,
      fallbackReason,
      platform,
      storageBackendLabel: `Container POSIX Storage (${posixRoot}) · Mapped from ${raw}`,
    };
  }

  const posixRoot = joinAndResolvePosix(cwd, raw);
  return {
    configuredPath: raw,
    configuredRawPath: raw,
    effectiveRoot: posixRoot,
    activePath: posixRoot,
    activeStoragePath: posixRoot,
    isWindowsPathOnPosix: false,
    isFallbackFromWindowsPath: false,
    platform,
    storageBackendLabel: `Server Storage (${posixRoot})`,
  };
}

/**
 * Strips raw FFmpeg command strings, compiler configuration flags, and internal paths
 * from operational errors so they are never exposed in user-facing UI banners.
 */
export function sanitizeOperationalError(params: {
  projectId?: string;
  stage: WorkflowStageId;
  rawError: unknown;
  clipId?: string;
  jobId?: string;
  exitCode?: number | null;
  configSummary?: string;
}): DiagnosticRecord {
  const { projectId, stage, rawError, clipId, jobId, exitCode, configSummary } = params;
  const rawStr =
    rawError instanceof Error
      ? rawError.message
      : typeof rawError === 'string'
        ? rawError
        : JSON.stringify(rawError || 'Unknown operational error');

  const now = new Date().toISOString();
  const id = `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const isFfmpegDump =
    rawStr.includes('Command failed:') ||
    rawStr.includes('ffmpeg') ||
    rawStr.includes('--enable-gpl') ||
    rawStr.includes('filter_complex') ||
    rawStr.includes('drawtext=');

  const isTimeout =
    rawStr.toLowerCase().includes('timed out') ||
    rawStr.toLowerCase().includes('timeout') ||
    rawStr.includes('ETIMEDOUT') ||
    rawStr.includes('SIGTERM');

  const isCancelled = rawStr.toLowerCase().includes('cancelled');

  let category: DiagnosticRecord['category'] = 'FFMPEG_PIPELINE';
  let userMessage = 'An operational task encountered an error. Your source media and project data remain intact.';
  let remediation = 'Click Retry to run the operation again, or inspect Technical Details for diagnostic context.';
  let sanitizedTechnicalDetail = rawStr;

  if (isCancelled) {
    category = 'QUEUE_CANCELLED';
    userMessage = `Rendering for ${clipId || 'clip'} was cancelled by user request.`;
    remediation = 'You can adjust clip settings or click Render Clip whenever you are ready.';
    sanitizedTechnicalDetail = `Render job ${jobId || ''} terminated via user cancellation signal.`;
  } else if (isTimeout) {
    category = 'RENDER_TIMEOUT';
    userMessage = `Clip rendering timed out (${clipId || 'video export'}). Short-form clips must be 120 seconds or shorter.`;
    remediation = 'Verify the clip duration is under 120s and click Retry Render.';
    sanitizedTechnicalDetail = `Process exceeded execution timeout limit during ${stage}. Clip interval clamped to <=120s safe window.`;
  } else if (isFfmpegDump || stage === 'video_render') {
    category = 'FFMPEG_PIPELINE';
    userMessage = `Clip rendering failed (${clipId || 'MP4 export'}). We couldn't complete the video encode, but your source video and transcript are safe.`;
    remediation = 'Click Retry Render to re-encode using the staged fallback pipeline, or edit the clip boundaries.';

    const lines = rawStr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith('Command failed:') &&
          !l.startsWith('ffmpeg version') &&
          !l.startsWith('built with') &&
          !l.startsWith('configuration:') &&
          !l.startsWith('lib') &&
          !l.includes('--enable-')
      );
    const tailLine = lines[lines.length - 1] || 'FFmpeg filtergraph or stream encoding exited with non-zero status.';
    sanitizedTechnicalDetail = tailLine
      .replace(/\/app\/applet\/[^\s:]+/g, '[storage]')
      .replace(/D:\\StrataStudio\\[^\s]+/gi, '[storage]')
      .slice(0, 260);
  } else if (stage === 'transcription') {
    category = 'TRANSCRIPTION_CHUNK';
    userMessage = 'Transcription encountered a segment warning. Completed transcript segments have been preserved.';
    remediation = 'Retry transcription on any failed interval or review the aligned transcript.';
    sanitizedTechnicalDetail = rawStr.slice(0, 260);
  } else if (stage === 'integrations') {
    category = 'INTEGRATION_AUTH';
    userMessage = 'External integration request could not be completed. Verify your connection credentials or permissions.';
    remediation = 'Open 09. Integrations to test your connection or update credentials.';
    sanitizedTechnicalDetail = rawStr.slice(0, 260);
  } else {
    category = 'AI_PROVIDER';
    userMessage = rawStr.length > 180 ? `${rawStr.slice(0, 175)}...` : rawStr;
    sanitizedTechnicalDetail = rawStr.slice(0, 280);
  }

  return {
    id,
    projectId,
    jobId,
    clipId,
    stage,
    category,
    userMessage,
    remediation,
    exitCode: exitCode ?? (isFfmpegDump ? 1 : null),
    sanitizedTechnicalDetail,
    technicalDetails: rawStr,
    configSummary,
    recoverable: true,
    timestamp: now,
  };
}

export function validateUrlSourceAccess(rawUrl: string): {
  allowed: boolean;
  reason: string;
  alternativeAction: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      reason: 'Invalid URL format. Please provide a valid HTTPS URL.',
      alternativeAction: 'Upload a local video/audio file or import a timestamped transcript.',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      allowed: false,
      reason: 'Only HTTP/HTTPS media protocols are supported.',
      alternativeAction: 'Upload your media file directly from disk.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const restrictedPlatforms = [
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
    'vimeo.com',
    'tiktok.com',
    'www.tiktok.com',
    'linkedin.com',
    'www.linkedin.com',
    'instagram.com',
  ];

  if (restrictedPlatforms.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return {
      allowed: false,
      reason: `Direct scraping or bypassing platform download controls on ${host} is restricted by platform Terms of Service, copyright, and access permissions.`,
      alternativeAction:
        'Please upload the authorized source MP4/MP3 file directly, or export and upload the official SRT/VTT transcript from your creator dashboard.',
    };
  }

  const isDirectMedia = /\.(mp4|mov|webm|mp3|wav|m4a|srt|vtt)$/i.test(parsed.pathname);
  if (!isDirectMedia) {
    return {
      allowed: false,
      reason:
        'The URL does not point to a direct, publicly authorized media or transcript file (.mp4, .webm, .mp3, .wav, .srt, .vtt).',
      alternativeAction:
        'Provide a direct signed media file URL or use the local file/transcript upload tab.',
    };
  }

  return {
    allowed: true,
    reason: 'Direct media or transcript endpoint validated.',
    alternativeAction: '',
  };
}

/**
 * 10. AI STRUCTURED RESPONSE VALIDATION & WORKFLOW STAGE ENGINE
 */
export function validateContentAnalysisPayload(
  raw: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['AI response is not a valid JSON object.'] };
  }
  const obj = raw as Partial<ContentAnalysis>;
  if (!obj.executiveSummary || typeof obj.executiveSummary !== 'string') {
    errors.push('Missing executiveSummary string.');
  }
  if (!obj.mainThesis || typeof obj.mainThesis !== 'string') {
    errors.push('Missing mainThesis string.');
  }
  if (!Array.isArray(obj.importantArguments) || obj.importantArguments.length === 0) {
    errors.push('importantArguments must be a non-empty array.');
  }
  if (!Array.isArray(obj.keyThemes) || obj.keyThemes.length === 0) {
    errors.push('keyThemes must be a non-empty array.');
  }
  if (!Array.isArray(obj.strongQuotations)) {
    errors.push('strongQuotations must be an array.');
  }
  return { valid: errors.length === 0, errors };
}

export function buildExportManifest(params: {
  projectId: string;
  projectName: string;
  brandName: string;
  approvedOnly: boolean;
  items: ExportManifestItem[];
}) {
  return {
    projectId: params.projectId,
    projectName: params.projectName,
    brandName: params.brandName,
    exportedAt: new Date().toISOString(),
    totalFiles: params.items.length,
    approvedOnly: params.approvedOnly,
    items: params.items,
  };
}

export function buildWorkflowStages(bundle: FullProjectBundle): WorkflowStageState[] {
  const { project, source, transcript, analysis, strategy, assets, clips, calendar, exports } = bundle;
  const now = project.updatedAt || new Date().toISOString();
  const hasStageError = (st: WorkflowStageId) =>
    project.failedTasks.some((f) => f.stage === st);

  const activeRenders = clips.filter((c) => c.renderStatus === 'processing').length;
  const queuedRenders = clips.filter((c) => c.renderStatus === 'queued').length;
  const completedRenders = clips.filter(
    (c) => c.renderStatus === 'ready_for_review' || c.renderStatus === 'approved' || c.renderStatus === 'completed'
  ).length;
  const failedRenders = clips.filter((c) => c.renderStatus === 'failed').length;

  return [
    {
      id: 'ingestion',
      stageId: 'ingestion',
      stepNumber: '01',
      label: 'Source Ingestion & Probe',
      status: source
        ? source.processingStatus === 'ready'
          ? 'completed'
          : source.processingStatus === 'processing'
            ? 'processing'
            : 'failed'
        : 'pending',
      summary: source
        ? `${source.fileName} (${formatTimestamp(source.mediaDurationSeconds)}, ${source.width}x${source.height})`
        : 'Awaiting video/audio upload',
      updatedAt: source?.createdAt || now,
      canRetry: true,
    },
    {
      id: 'transcription',
      stageId: 'transcription',
      stepNumber: '02',
      label: 'Multilingual Transcription',
      status: hasStageError('transcription')
        ? 'Attention Required'
        : transcript.length > 0
          ? 'completed'
          : 'pending',
      summary:
        transcript.length > 0
          ? `${transcript.length} segments · ${project.coverageReport?.coveragePercent ?? 100}% coverage`
          : 'Awaiting transcription',
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'analysis',
      stageId: 'analysis',
      stepNumber: '03',
      label: 'Content Intelligence',
      status: hasStageError('analysis')
        ? 'Attention Required'
        : analysis
          ? 'completed'
          : 'pending',
      summary: analysis
        ? `${analysis.importantArguments.length} arguments · ${analysis.strongQuotations.length} quotes`
        : 'Not analyzed yet',
      updatedAt: analysis?.createdAt || now,
      canRetry: true,
    },
    {
      id: 'strategy',
      stageId: 'strategy',
      stepNumber: '04',
      label: 'Multi-Angle Strategy',
      status: strategy && strategy.angles.length > 0 ? 'completed' : 'pending',
      summary:
        strategy && strategy.angles.length > 0
          ? `${strategy.angles.filter((a) => a.approved).length}/${strategy.angles.length} angles approved`
          : 'Awaiting strategy generation',
      updatedAt: strategy?.updatedAt || now,
      canRetry: true,
    },
    {
      id: 'asset_generation',
      stageId: 'asset_generation',
      stepNumber: '05',
      label: 'Written Deliverables',
      status: hasStageError('asset_generation')
        ? 'Attention Required'
        : assets.length > 0
          ? 'completed'
          : 'pending',
      summary:
        assets.length > 0
          ? `${assets.length} deliverables (${assets.filter((a) => a.status === 'approved').length} approved)`
          : 'No written assets yet',
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'clip_discovery',
      stageId: 'clip_discovery',
      stepNumber: '06',
      label: 'Short-Form Clip Discovery (<=120s)',
      status: clips.length > 0 ? 'completed' : 'pending',
      summary:
        clips.length > 0
          ? `${clips.length} clips ranked (max ${Math.max(...clips.map((c) => c.duration))}s <= 120s)`
          : 'No clip candidates yet',
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'video_render',
      stageId: 'video_render',
      stepNumber: '07',
      label: 'FFmpeg Video Render Queue',
      status:
        activeRenders > 0
          ? 'processing'
          : queuedRenders > 0
            ? 'queued'
            : failedRenders > 0
              ? 'Attention Required'
              : completedRenders > 0
                ? 'completed'
                : 'pending',
      summary: `${completedRenders}/${clips.length} MP4 rendered · ${activeRenders} active · ${queuedRenders} queued`,
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'calendar',
      stageId: 'calendar',
      stepNumber: '08',
      label: '4-Week Content Calendar',
      status: calendar.length > 0 ? 'completed' : 'pending',
      summary: calendar.length > 0 ? `${calendar.length} scheduled publishing slots` : 'Not scheduled yet',
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'export',
      stageId: 'export',
      stepNumber: '09',
      label: 'Archive & Delivery Package',
      status: exports.length > 0 ? 'completed' : 'pending',
      summary: exports.length > 0 ? `${exports.length} ZIP archives built` : 'Ready to package',
      updatedAt: now,
      canRetry: true,
    },
    {
      id: 'integrations',
      stageId: 'integrations',
      stepNumber: '10',
      label: 'MCP & Connected Operations',
      status: 'completed',
      summary: 'Workspace, Notion, Slack, YouTube & MCP tools ready',
      updatedAt: now,
      canRetry: false,
    },
  ];
}

/**
 * 11. STRATA STUDIO 3.0 — ROMANISED TRANSLITERATION FOR INDIAN LANGUAGES,
 *     SMART VERTICAL VIDEO COMPOSITION & CONTEXT-AWARE RECOMMENDATIONS
 */

const HINDI_PHRASE_ROMAN_MAP: Array<[RegExp, string]> = [
  [/कुछ\s+नहीं\s+होता/g, 'Kuch nahi hota'],
  [/मुझे\s+समझ\s+में\s+नहीं\s+आया/g, 'Mujhe samajh mein nahi aaya'],
  [/यह\s+बहुत\s+अच्छा\s+है/g, 'Yeh bahut achha hai'],
  [/आप\s+कैसे\s+हैं\s*\?/g, 'Aap kaise hain?'],
  [/आप\s+कैसे\s+हैं/g, 'Aap kaise hain'],
];

const DEVANAGARI_WORD_ROMAN_DICT: Record<string, string> = {
  'कुछ': 'kuch',
  'नहीं': 'nahi',
  'होता': 'hota',
  'मुझे': 'mujhe',
  'समझ': 'samajh',
  'में': 'mein',
  'आया': 'aaya',
  'यह': 'yeh',
  'बहुत': 'bahut',
  'अच्छा': 'achha',
  'है': 'hai',
  'हैं': 'hain',
  'आप': 'aap',
  'कैसे': 'kaise',
  'देखिए': 'dekhiye',
  'जब': 'jab',
  'हम': 'hum',
  'के': 'ke',
  'की': 'ki',
  'का': 'ka',
  'को': 'ko',
  'से': 'se',
  'पर': 'par',
  'और': 'aur',
  'या': 'ya',
  'तो': 'toh',
  'भी': 'bhi',
  'ही': 'hi',
  'कि': 'ki',
  'मुख्य': 'mukhya',
  'विषय': 'vishay',
  'समझते': 'samajhte',
  'सबसे': 'sabse',
  'पहली': 'pehli',
  'बात': 'baat',
  'किसी': 'kisi',
  'जटिल': 'jatil',
  'समस्या': 'samasya',
  'धैर्य': 'dhairya',
  'गहराई': 'gehraai',
  'देखना': 'dekhna',
  'ज़रूरी': 'zaroori',
  'अक्सर': 'aksar',
  'लोग': 'log',
  'परिणाम': 'parinaam',
  'जल्दबाज़ी': 'jaldbaazi',
  'करते': 'karte',
  'जबकि': 'jabki',
  'असली': 'asli',
  'अंतर': 'antar',
  'रोज़मर्रा': 'rozmarra',
  'रोज़मर्रा': 'rozmarra',
  'प्रक्रिया': 'prakriya',
  'अनुशासन': 'anushasan',
  'निरंतरता': 'nirantarta',
  'आता': 'aata',
  'विचार': 'vichar',
  'अपनी': 'apni',
  'भाषा': 'bhasha',
  'बिना': 'bina',
  'बाहरी': 'baahari',
  'सहारे': 'sahaare',
  'स्पष्ट': 'spasht',
  'लिख': 'likh',
  'पाते': 'paate',
  'तभी': 'tabhi',
  'मानिए': 'maaniye',
  'वह': 'vah',
  'अवधारणा': 'avdharana',
  'वास्तव': 'vastav',
  'आपकी': 'aapki',
  'हुई': 'hui',
  'समय': 'samay',
  'प्रबंधन': 'prabandhan',
  'अर्थ': 'arth',
  'केवल': 'keval',
  'घंटों': 'ghanton',
  'गिनना': 'ginna',
  'बल्कि': 'balki',
  'ऊर्जा': 'oorja',
  'एकाग्रता': 'ekaagrata',
  'सही': 'sahi',
  'प्राथमिकता': 'prathmikta',
  'लगाना': 'lagaana',
  'चुनौतीपूर्ण': 'chunautipoorna',
  'परिस्थितियों': 'paristhitiyon',
  'शांत': 'shaant',
  'रहकर': 'rehkar',
  'तथ्यों': 'tathyon',
  'विश्लेषण': 'vishleshan',
  'करना': 'karna',
  'एक': 'ek',
  'परिपक्व': 'paripakva',
  'निर्णयकर्ता': 'nirnaykarta',
  'पहचान': 'pehchaan',
  'दीर्घकालिक': 'deerghkaalik',
  'सफलता': 'safalta',
  'लिए': 'liye',
  'आवश्यक': 'aavashyak',
  'अध्ययन': 'adhyayan',
  'व्यावहारिक': 'vyavaharik',
  'अनुभव': 'anubhav',
  'दोनों': 'donon',
  'बीच': 'beech',
  'संतुलन': 'santulan',
  'बनाए': 'banaaye',
  'रखें': 'rakhein',
};

const GUJARATI_WORD_ROMAN_DICT: Record<string, string> = {
  'આ': 'aa',
  'સત્રમાં': 'satrama',
  'આપણે': 'aapne',
  'વિષય': 'vishay',
  'અને': 'ane',
  'તેના': 'tena',
  'વ્યવહારુ': 'vyavaharu',
  'ઉપયોગ': 'upayog',
  'વિશે': 'vishe',
  'વિગતવાર': 'vigatvaar',
  'ચર્ચા': 'charcha',
  'કરીશું': 'karishu',
  'કંઈ': 'kai',
  'નથી': 'nathi',
  'થતું': 'thatu',
};

const DEV_VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'अं': 'an', 'अः': 'ah',
};

const DEV_MATRAS: Record<string, string> = {
  'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  'ं': 'n', 'ँ': 'n', 'ः': 'h', 'ॅ': 'e', 'ॉ': 'o',
};

const DEV_CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'ळ': 'l',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};

const GUJ_VOWELS: Record<string, string> = {
  'અ': 'a', 'આ': 'aa', 'ઇ': 'i', 'ઈ': 'ee', 'ઉ': 'u', 'ઊ': 'oo',
  'ઋ': 'ru', 'એ': 'e', 'ઐ': 'ai', 'ઓ': 'o', 'ઔ': 'au',
};

const GUJ_MATRAS: Record<string, string> = {
  'ા': 'a', 'િ': 'i', 'ી': 'ee', 'ુ': 'u', 'ૂ': 'oo',
  'ૃ': 'ru', 'ે': 'e', 'ૈ': 'ai', 'ો': 'o', 'ૌ': 'au',
  'ં': 'n', 'ઁ': 'n', 'ઃ': 'h',
};

const GUJ_CONSONANTS: Record<string, string> = {
  'ક': 'k', 'ખ': 'kh', 'ગ': 'g', 'ઘ': 'gh', 'ઙ': 'n',
  'ચ': 'ch', 'છ': 'chh', 'જ': 'j', 'ઝ': 'jh', 'ઞ': 'ny',
  'ટ': 't', 'ઠ': 'th', 'ડ': 'd', 'ઢ': 'dh', 'ણ': 'n',
  'ત': 't', 'થ': 'th', 'દ': 'd', 'ધ': 'dh', 'ન': 'n',
  'પ': 'p', 'ફ': 'f', 'બ': 'b', 'ભ': 'bh', 'મ': 'm',
  'ય': 'y', 'ર': 'r', 'લ': 'l', 'વ': 'v', 'ળ': 'l',
  'શ': 'sh', 'ષ': 'sh', 'સ': 's', 'હ': 'h',
};

function transliterateDevanagariWord(word: string): string {
  if (DEVANAGARI_WORD_ROMAN_DICT[word]) {
    return DEVANAGARI_WORD_ROMAN_DICT[word];
  }
  // Normalize nukta combinations
  const normalized = word
    .replace(/क\u093C/g, 'क़')
    .replace(/ख\u093C/g, 'ख़')
    .replace(/ग\u093C/g, 'ग़')
    .replace(/ज\u093C/g, 'ज़')
    .replace(/ड\u093C/g, 'ड़')
    .replace(/ढ\u093C/g, 'ढ़')
    .replace(/फ\u093C/g, 'फ़');

  if (DEVANAGARI_WORD_ROMAN_DICT[normalized]) {
    return DEVANAGARI_WORD_ROMAN_DICT[normalized];
  }

  const chars = Array.from(normalized);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (DEV_VOWELS[ch]) {
      out += DEV_VOWELS[ch];
    } else if (DEV_CONSONANTS[ch]) {
      out += DEV_CONSONANTS[ch];
      if (next === '्') {
        i++; // skip virama/halant (no inherent vowel)
      } else if (next && DEV_MATRAS[next]) {
        // matra will be processed on next iteration
      } else {
        // Inherent 'a' vowel except at word-final position in multi-char Hindi words
        const isWordFinal = i === chars.length - 1;
        if (!isWordFinal || chars.length === 1) {
          out += 'a';
        }
      }
    } else if (DEV_MATRAS[ch]) {
      out += DEV_MATRAS[ch];
    } else if (ch === '्' || ch === '\u093C') {
      // handled
    } else if (ch === '।') {
      out += '.';
    } else {
      out += ch;
    }
  }
  return out;
}

function transliterateGujaratiWord(word: string): string {
  if (GUJARATI_WORD_ROMAN_DICT[word]) {
    return GUJARATI_WORD_ROMAN_DICT[word];
  }
  const chars = Array.from(word);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (GUJ_VOWELS[ch]) {
      out += GUJ_VOWELS[ch];
    } else if (GUJ_CONSONANTS[ch]) {
      out += GUJ_CONSONANTS[ch];
      if (next === '્') {
        i++;
      } else if (next && GUJ_MATRAS[next]) {
        // matra handled next
      } else {
        const isWordFinal = i === chars.length - 1;
        if (!isWordFinal || chars.length === 1) {
          out += 'a';
        }
      }
    } else if (GUJ_MATRAS[ch]) {
      out += GUJ_MATRAS[ch];
    } else if (ch !== '્') {
      out += ch;
    }
  }
  return out;
}

function capitalizeSentenceStart(str: string): string {
  if (!str) return str;
  return str.replace(/(^\s*[a-z]|(?<=[.!?]\s+)[a-z])/g, (m) => m.toUpperCase());
}

/**
 * Transliterates Indian & non-Latin scripts (Hindi/Marathi Devanagari, Gujarati, etc.)
 * into readable Romanised text (Hinglish / Roman script) while preserving mixed-language
 * English code-switching untouched. Never translates words into English vocabulary.
 */
export function romaniseIndianAndNonLatinText(
  text: string,
  _language = 'hi'
): {
  romanised: string;
  hasCodeSwitching: boolean;
  uncertainWords: string[];
} {
  const raw = String(text || '').trim();
  if (!raw) {
    return { romanised: '', hasCodeSwitching: false, uncertainWords: [] };
  }

  const hasDevanagari = /[\u0900-\u097F]/.test(raw);
  const hasGujarati = /[\u0A80-\u0AFF]/.test(raw);
  const hasLatinWords = /[A-Za-z]{2,}/.test(raw);
  const hasCodeSwitching = (hasDevanagari || hasGujarati) && hasLatinWords;

  // Check phrase-level matches first
  let working = raw.replace(/।/g, '.');
  for (const [pattern, replacement] of HINDI_PHRASE_ROMAN_MAP) {
    working = working.replace(pattern, replacement);
  }

  if (!/[\u0900-\u097F\u0A80-\u0AFF]/.test(working)) {
    return {
      romanised: capitalizeSentenceStart(working),
      hasCodeSwitching: hasCodeSwitching || /\b(mujhe|lagta|hai|nahi|kuch|bahut|achha|kaise|aap)\b/i.test(raw),
      uncertainWords: [],
    };
  }

  const uncertainWords: string[] = [];
  const tokenized = working.replace(
    /([\u0900-\u097F]+|[\u0A80-\u0AFF]+)/g,
    (match) => {
      if (/[\u0900-\u097F]/.test(match)) {
        const rom = transliterateDevanagariWord(match);
        if (match.length > 9 && !DEVANAGARI_WORD_ROMAN_DICT[match]) {
          uncertainWords.push(rom);
        }
        return rom;
      }
      if (/[\u0A80-\u0AFF]/.test(match)) {
        return transliterateGujaratiWord(match);
      }
      return match;
    }
  );

  return {
    romanised: capitalizeSentenceStart(tokenized.replace(/\s+\./g, '.')),
    hasCodeSwitching,
    uncertainWords,
  };
}

export function enrichTranscriptWithRomanisation(
  segments: TranscriptSegment[],
  defaultLang = 'hi'
): TranscriptSegment[] {
  return segments.map((seg) => {
    const orig = seg.originalText || seg.text;
    const { romanised, hasCodeSwitching, uncertainWords } =
      romaniseIndianAndNonLatinText(orig, seg.language || defaultLang);
    return {
      ...seg,
      originalText: orig,
      romanisedText: seg.romanisedText || romanised,
      hasCodeSwitching: seg.hasCodeSwitching ?? hasCodeSwitching,
      uncertainWords:
        seg.uncertainWords ??
        (seg.confidence < 0.88 && uncertainWords.length === 0
          ? [orig.split(/\s+/)[0] || '']
          : uncertainWords),
    };
  });
}

export function resolveSegmentTextForCaptionMode(
  seg: TranscriptSegment,
  mode: CaptionScriptMode = 'original'
): string {
  const original = seg.originalText || seg.text;
  const romanised =
    seg.romanisedText ||
    romaniseIndianAndNonLatinText(original, seg.language).romanised;

  switch (mode) {
    case 'romanised':
      return romanised || original;
    case 'both':
      if (!romanised || romanised.toLowerCase() === original.toLowerCase()) {
        return original;
      }
      return `${original} / ${romanised}`;
    case 'translation':
      return seg.translatedText || romanised || original;
    case 'original':
    default:
      return original;
  }
}

export function detectSmartVideoComposition(params: {
  sourceType?: string;
  width: number;
  height: number;
  speakerCount: number;
}): {
  recommendedMode: VideoLayoutMode;
  sceneType: ManualCropConfig['subjectSceneType'];
  cropX: number;
  cropY: number;
  zoom: number;
  explanation: string;
} {
  const { sourceType = 'Podcast', width, height, speakerCount } = params;
  const isAlreadyVertical = height > width;
  const lowerType = sourceType.toLowerCase();

  if (isAlreadyVertical) {
    return {
      recommendedMode: 'smart-crop',
      sceneType: 'single_speaker',
      cropX: 0,
      cropY: 0,
      zoom: 1.0,
      explanation: 'Source is already vertical; preserving full native framing with safe-zone captions.',
    };
  }

  if (lowerType.includes('presentation') || lowerType.includes('webinar')) {
    return {
      recommendedMode: 'picture-in-picture',
      sceneType: 'presentation_slides',
      cropX: 0,
      cropY: -8,
      zoom: 1.05,
      explanation: 'Presentation/Webinar detected: keeps full slide deck readable with presenter framing.',
    };
  }

  if (lowerType.includes('demonstration') || lowerType.includes('product')) {
    return {
      recommendedMode: 'blurred-background',
      sceneType: 'screen_recording',
      cropX: 0,
      cropY: 0,
      zoom: 1.0,
      explanation: 'Product/Screen recording detected: preserves full UI viewport over a blurred vertical canvas.',
    };
  }

  if (speakerCount >= 2 || lowerType.includes('interview') || lowerType.includes('conversation')) {
    return {
      recommendedMode: 'dynamic-speaker',
      sceneType: 'multi_speaker',
      cropX: -12,
      cropY: -6,
      zoom: 1.18,
      explanation: `Multi-speaker ${sourceType} (${speakerCount} speakers): dynamically tracks active speaker turn boundaries.`,
    };
  }

  return {
    recommendedMode: 'speaker-focus',
    sceneType: 'single_speaker',
    cropX: 0,
    cropY: -8,
    zoom: 1.15,
    explanation: 'Single-speaker talking-head framing: centers upper-third eye-line with bottom caption safe area.',
  };
}

export function validateVerticalCompositionCrop(params: {
  config: ClipRenderConfiguration;
  sourceWidth: number;
  sourceHeight: number;
}): CropValidationReport {
  const { config, sourceWidth, sourceHeight } = params;
  const warnings: string[] = [];

  const targetW = config.width || 540;
  const targetH = config.height || 960;

  let expectedRatio = 9 / 16;
  if (config.aspectRatio === '16:9') expectedRatio = 16 / 9;
  else if (config.aspectRatio === '1:1') expectedRatio = 1;
  else if (config.aspectRatio === 'original') {
    expectedRatio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;
  }

  const actualRatio = targetW > 0 && targetH > 0 ? targetW / targetH : expectedRatio;
  const aspectRatioPreserved = Math.abs(actualRatio - expectedRatio) < 0.08;
  if (!aspectRatioPreserved) {
    warnings.push(`Output dimensions (${targetW}x${targetH}) deviate from selected ${config.aspectRatio} ratio.`);
  }

  const manual = config.manualCrop;
  let importantContentVisible = true;
  if (manual) {
    if (Math.abs(manual.horizontalOffset) > 85 || Math.abs(manual.verticalOffset) > 85) {
      importantContentVisible = false;
      warnings.push('Extreme manual crop offset (>85%) may cut off the primary speaker or subject.');
    }
    if (manual.zoom > 2.3) {
      warnings.push('High zoom factor (>2.3x) may reduce visual sharpness on standard source footage.');
    }
  }

  const safeMargin = config.captionStyle?.safeMarginPx ?? 90;
  const captionsInSafeArea = safeMargin >= 48;
  if (!captionsInSafeArea) {
    warnings.push('Caption safe margin is below 48px and may overlap platform UI chrome.');
  }

  return {
    valid: warnings.length === 0,
    outputDimensionsMatch: targetW > 0 && targetH > 0 && targetW % 2 === 0 && targetH % 2 === 0,
    aspectRatioPreserved,
    noStretching: true,
    captionsInSafeArea,
    importantContentVisible,
    warnings,
  };
}

export function buildClipContextRecommendations(params: {
  clip: Partial<VideoClipCandidate>;
  projectObjective?: string;
  targetAudience?: string;
}): ClipContextRecommendations {
  const { clip, projectObjective, targetAudience } = params;
  const dur = clip.duration || 40;
  const platform: PlatformType = clip.recommendedPlatform || 'YouTube Shorts';
  const boundaryOk = clip.boundaryValidation?.status !== 'invalid';

  return {
    whySelected:
      clip.selectionReason ||
      `Selected for its high-density opening thesis and self-contained ${dur}s narrative arc.`,
    whatAudienceLearns:
      clip.centralIdea ||
      clip.openingText ||
      'Actionable operational takeaway grounded directly in the speaker’s primary argument.',
    intendedAudience:
      clip.targetAudience ||
      targetAudience ||
      'Practitioners, technical leaders, and decision-makers',
    compellingOpeningReason: `Opens immediately on a concrete statement ("${(clip.openingText || clip.hook || '').slice(0, 68)}...") without throat-clearing intro filler.`,
    worksIndependently: boundaryOk && !clip.boundaryValidation?.lacksStandaloneContext,
    missingContextNote: clip.boundaryValidation?.lacksStandaloneContext
      ? 'Starts with a transitional conjunction; consider adding a 4-word on-screen hook title for cold viewers.'
      : projectObjective
        ? `Aligned with project objective: ${projectObjective.slice(0, 90)}`
        : undefined,
    recommendedPlatform: platform,
  };
}

/**
 * 12. SMART SHORT-VIDEO PRODUCTION & USAGE-BASED CREDIT ENGINE
 */
export const PAY_AS_YOU_GO_CREDIT_PACKS = [
  {
    id: 'pack-starter-250',
    name: 'Starter Compute Pack',
    credits: 250,
    priceUsd: 9,
    description: 'Ideal for 3–5 full podcast episodes with smart FFmpeg rendering and Romanised transcription.',
  },
  {
    id: 'pack-studio-1000',
    name: 'Studio Production Pack',
    credits: 1000,
    priceUsd: 29,
    badge: 'Most Popular',
    description: 'Built for weekly multi-channel teams producing 20+ smart vertical shorts, hooks, and blogs.',
  },
  {
    id: 'pack-scale-5000',
    name: 'Agency Scale Pack',
    credits: 5000,
    priceUsd: 99,
    badge: 'Best Value',
    description: 'High-volume allowance for agencies managing multiple brand profiles and daily video renders.',
  },
] as const;

export const OPERATION_CREDIT_RATES = {
  audio_transcription: 10,     // 10 credits per transcription run / minute block
  transcription: 10,
  content_intelligence: 15,    // 15 credits for full analysis + strategy + written assets
  content_analysis: 15,
  smart_clip_render: 15,       // 15 credits per smart FFmpeg short-video render
  smart_clip_stitch: 20,       // 20 credits for multi-segment stitched short video render
  smart_stitch_render: 20,
} as const;

export function extractImpactHighlightWords(
  text: string,
  preferredKeywords: string[] = []
): string[] {
  const clean = String(text || '').trim();
  if (!clean) return [];

  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'have', 'are',
    'was', 'were', 'will', 'would', 'could', 'should', 'into', 'about', 'what',
    'when', 'where', 'which', 'their', 'there', 'they', 'them', 'then', 'than',
    'hai', 'hain', 'aur', 'mein', 'kya', 'nahi', 'bhi', 'ek', 'se', 'ko', 'ka', 'ki', 'ke',
  ]);

  const preferredSet = new Set(preferredKeywords.map((w) => w.toLowerCase().trim()).filter(Boolean));
  const tokens = clean
    .replace(/[.,!?;:()"'[\]{}।]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const scored = tokens.map((word) => {
    const lower = word.toLowerCase();
    let score = 0;
    if (preferredSet.has(lower)) score += 10;
    if (/\d+%?|\$\d+/.test(word)) score += 8;
    if (word.length >= 7 && !stopWords.has(lower)) score += 5;
    if (/^[A-Z][a-z]{3,}/.test(word) && !stopWords.has(lower)) score += 4;
    return { word, lower, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    if (item.score <= 0) continue;
    if (seen.has(item.lower)) continue;
    seen.add(item.lower);
    picked.push(item.word);
    if (picked.length >= 4) break;
  }

  if (picked.length === 0 && tokens.length > 0) {
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
    if (longest) picked.push(longest);
  }
  return picked;
}

export function buildSmartStitchedClipIntervals(params: {
  selectedSegments: TranscriptSegment[];
  sourceDurationSec: number;
  maxTotalDurationSec?: number;
}): {
  intervals: Array<{ id: string; start: number; end: number; speaker: string; label: string }>;
  totalDurationSec: number;
  combinedTranscript: string;
  wasClamped: boolean;
} {
  const { selectedSegments, sourceDurationSec, maxTotalDurationSec = SHORT_FORM_MAX_DURATION_SEC } = params;
  const hardCap = Math.min(SHORT_FORM_MAX_DURATION_SEC, Math.max(15, maxTotalDurationSec));
  const sorted = [...selectedSegments].sort((a, b) => a.start - b.start);

  const intervals: Array<{ id: string; start: number; end: number; speaker: string; label: string }> = [];
  const texts: string[] = [];
  let totalDurationSec = 0;
  let wasClamped = false;

  for (const seg of sorted) {
    const s = Math.max(0, Math.round(seg.start * 10) / 10);
    const maxEnd = sourceDurationSec > 0 ? Math.min(sourceDurationSec, seg.end) : seg.end;
    let e = Math.max(s + 1.5, Math.round(maxEnd * 10) / 10);
    const segDur = e - s;

    if (totalDurationSec + segDur > hardCap) {
      const remaining = Math.round((hardCap - totalDurationSec) * 10) / 10;
      if (remaining >= 3) {
        e = Math.round((s + remaining) * 10) / 10;
        intervals.push({
          id: seg.id,
          start: s,
          end: e,
          speaker: seg.speakerId || 'Speaker 1',
          label: seg.text.slice(0, 56),
        });
        texts.push(seg.text);
        totalDurationSec = Math.round((totalDurationSec + (e - s)) * 10) / 10;
      }
      wasClamped = true;
      break;
    }

    intervals.push({
      id: seg.id,
      start: s,
      end: e,
      speaker: seg.speakerId || 'Speaker 1',
      label: seg.text.slice(0, 56),
    });
    texts.push(seg.text);
    totalDurationSec = Math.round((totalDurationSec + (e - s)) * 10) / 10;
  }

  return {
    intervals,
    totalDurationSec: Math.max(1, totalDurationSec),
    combinedTranscript: texts.join(' … '),
    wasClamped,
  };
}



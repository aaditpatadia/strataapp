import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {
  SHORT_FORM_MAX_DURATION_SEC,
  buildExportManifest,
  calculateClipDuration,
  calculateWeightedEditorialScore,
  clampClipIntervalToShortForm,
  computeTranscriptCoverageReport,
  createClipFromTranscriptSelection,
  detectOverlappingClips,
  detectSmartVideoComposition,
  enrichTranscriptWithRomanisation,
  formatBlogMarkdown,
  formatSrtTimestamp,
  formatTimestamp,
  generateCalendarCsv,
  generateClipSrt,
  generateCutSheetCsv,
  generateDeterministicCalendar,
  mergeChunkedTranscriptSegments,
  parseTimestamp,
  parseTranscriptInput,
  resolveBrandAssumptions,
  resolveEnvironmentStoragePaths,
  romaniseIndianAndNonLatinText,
  sanitizeFilename,
  sanitizeOperationalError,
  validateClipBoundaries,
  validateContentAnalysisPayload,
  validateSafeProjectPath,
  validateTranscriptSegments,
  validateUrlSourceAccess,
  validateVerticalCompositionCrop,
} from './coreLogic';
import {
  ensureSampleMediaFixture,
  ensureWebPlayableVideo,
  probeMediaFile,
  renderVideoClipWithFfmpeg,
} from '../server/ffmpegEngine';
import { buildDurationCalibratedTranscript } from '../server/aiProvider';
import { buildOptimisticMediaPreview } from './uploadClient';
import type {
  AssetDeliverable,
  TranscriptSegment,
  VideoClipCandidate,
} from '../types/domain';

const FIXTURE_TRANSCRIPT: TranscriptSegment[] = [
  {
    id: 'seg-001',
    sourceId: 'src-1',
    start: 0,
    end: 14,
    text: 'Most enterprise engineering organizations are unknowingly paying a thirty-eight percent idle compute tax on their Kubernetes clusters.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.99,
    timingVerified: true,
  },
  {
    id: 'seg-002',
    sourceId: 'src-1',
    start: 14,
    end: 30,
    text: 'When we audited forty-two production clusters last quarter, the root cause was never traffic spikes. It was static memory reservations set during initial service launch.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.98,
    timingVerified: true,
  },
  {
    id: 'seg-003',
    sourceId: 'src-1',
    start: 30,
    end: 46,
    text: 'Engineers pad resource requests by three hundred percent because nobody gets paged for an oversized pod, whereas an out-of-memory kill triggers an immediate incident.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.99,
    timingVerified: true,
  },
];

test('1. Timestamp parsing and formatting handles standard, SRT, and invalid inputs', () => {
  assert.equal(parseTimestamp('01:30'), 90);
  assert.equal(parseTimestamp('00:02:15.500'), 135.5);
  assert.equal(parseTimestamp('00:00:14,250'), 14.25);
  assert.equal(parseTimestamp(42.125), 42.125);
  assert.equal(parseTimestamp('-5'), null);
  assert.equal(parseTimestamp('invalid'), null);
  assert.equal(formatTimestamp(95), '01:35');
  assert.equal(formatSrtTimestamp(14.25), '00:00:14,250');
});

test('2. Transcript parsing and validation distinguishes verified vs estimated timing', () => {
  const srtInput = `1\n00:00:00,000 --> 00:00:12,000\nDr. Elena Vance: Welcome to the architecture briefing.\n\n2\n00:00:12,000 --> 00:00:25,000\nDr. Elena Vance: Let us inspect the telemetry.`;
  const parsedSrt = parseTranscriptInput(srtInput, 'src-test');
  assert.equal(parsedSrt.timingVerified, true);
  assert.equal(parsedSrt.segments.length, 2);
  assert.equal(parsedSrt.segments[0].speakerId, 'Dr. Elena Vance');

  const plainInput = `First paragraph without any timestamps.\n\nSecond paragraph explaining the architecture.`;
  const parsedPlain = parseTranscriptInput(plainInput, 'src-test', 'en', 30);
  assert.equal(parsedPlain.timingVerified, false);
  assert.equal(parsedPlain.segments.length, 2);
  assert.ok(parsedPlain.warnings.length > 0);

  const validation = validateTranscriptSegments(FIXTURE_TRANSCRIPT, 90);
  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
});

test('3. Clip duration calculation and boundary validation enforce source duration and sentence rules', () => {
  assert.equal(calculateClipDuration(14, 46), 32);
  assert.equal(calculateClipDuration(50, 20), 0);

  // Valid clip aligned with segment boundaries
  const validCheck = validateClipBoundaries({
    start: 0,
    end: 46,
    sourceDurationSec: 90,
    transcript: FIXTURE_TRANSCRIPT,
    minDurationSec: 20,
    maxDurationSec: 60,
  });
  assert.equal(validCheck.status, 'valid');
  assert.equal(validCheck.duration, 46);
  assert.equal(validCheck.matchedSegments.length, 3);

  // Out-of-bounds clip exceeding source media duration
  const invalidBounds = validateClipBoundaries({
    start: 60,
    end: 110,
    sourceDurationSec: 90,
    transcript: FIXTURE_TRANSCRIPT,
  });
  assert.equal(invalidBounds.status, 'invalid');
  assert.equal(invalidBounds.withinSourceDuration, false);

  // Mid-sentence cut warning
  const cutCheck = validateClipBoundaries({
    start: 5,
    end: 25,
    sourceDurationSec: 90,
    transcript: FIXTURE_TRANSCRIPT,
    minDurationSec: 15,
    maxDurationSec: 60,
  });
  assert.equal(cutCheck.cutsSentenceStart, true);
  assert.equal(cutCheck.cutsSentenceEnd, true);
  assert.equal(cutCheck.status, 'needs_review');
});

test('4. Clip editorial scoring and overlap detection flag repetitive segments', () => {
  const score = calculateWeightedEditorialScore(
    {
      openingStrength: 90,
      contentClarity: 85,
      completeness: 80,
      audienceRelevance: 95,
      standaloneUsefulness: 88,
      productionSuitability: 92,
    },
    {
      openingStrength: 25,
      contentClarity: 20,
      completeness: 15,
      audienceRelevance: 20,
      standaloneUsefulness: 10,
      productionSuitability: 10,
    }
  );
  assert.ok(score >= 85 && score <= 92);

  const mockClipA = {
    id: 'clip-a',
    start: 10,
    end: 40,
    duration: 30,
    boundaryValidation: {
      status: 'valid',
      warnings: [],
      cutsSentenceStart: false,
      cutsSentenceEnd: false,
      lacksStandaloneContext: false,
      withinSourceDuration: true,
      overlapsWithClipIds: [],
    },
  } as unknown as VideoClipCandidate;

  const mockClipB = {
    ...mockClipA,
    id: 'clip-b',
    start: 15,
    end: 45,
    duration: 30,
  } as unknown as VideoClipCandidate;

  const checked = detectOverlappingClips([mockClipA, mockClipB]);
  assert.deepEqual(checked[0].boundaryValidation.overlapsWithClipIds, ['clip-b']);
  assert.equal(checked[0].boundaryValidation.status, 'needs_review');
});

test('5. Brand profile assumption tracking records missing fields transparently', () => {
  const { normalizedBrand, assumptionsMade } = resolveBrandAssumptions({
    name: 'Acme Robotics',
  });
  assert.equal(normalizedBrand.name, 'Acme Robotics');
  assert.ok(assumptionsMade.length >= 3);
});

test('6. Structured AI response validation catches malformed payloads', () => {
  const badResult = validateContentAnalysisPayload({ executiveSummary: 'Only summary' });
  assert.equal(badResult.valid, false);
  assert.ok(badResult.errors.length >= 2);

  const goodResult = validateContentAnalysisPayload({
    executiveSummary: 'Complete summary.',
    mainThesis: 'Main thesis statement.',
    importantArguments: [{ id: 'arg-1', title: 'Arg', detail: 'Detail', classification: 'explicit_statement', segmentIds: ['seg-001'] }],
    keyThemes: ['Cloud Cost'],
    strongQuotations: [],
  });
  assert.equal(goodResult.valid, true);
});

test('7. Deterministic 4-week content calendar and ZIP export manifest generation', async () => {
  const sampleAssets: AssetDeliverable[] = [
    {
      id: 'asset-1',
      projectId: 'proj-1',
      assetType: 'seo_blog',
      platform: 'Blog / Organic Search',
      title: 'Eliminating Kubernetes Idle Tax',
      category: 'Educational',
      structuredData: {
        suggestedTitle: 'Eliminating Kubernetes Idle Tax',
        alternativeHeadlines: ['Alt 1'],
        searchIntent: 'Informational',
        primaryKeyword: 'kubernetes cost optimization',
        secondaryKeywords: ['finops'],
        metaTitle: 'Meta',
        metaDescription: 'Desc',
        urlSlug: 'kubernetes-idle-tax',
        introduction: 'Intro',
        sections: [{ heading: 'H1', body: 'Body', supportingSegmentIds: ['seg-001'] }],
        conclusion: 'Conclusion',
        internalLinkSuggestions: ['/docs'],
        callToAction: 'Audit now',
      },
      markdownContent: '# Eliminating Kubernetes Idle Tax',
      sourceSegmentIds: ['seg-001'],
      status: 'approved',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'asset-2',
      projectId: 'proj-1',
      assetType: 'linkedin_post',
      platform: 'LinkedIn',
      title: 'Why Engineers Pad Pods by 300%',
      category: 'Opinion-Led',
      structuredData: {},
      markdownContent: 'Post content',
      sourceSegmentIds: ['seg-003'],
      status: 'ready_for_review',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const calendar = generateDeterministicCalendar({
    projectId: 'proj-1',
    startDate: '2026-11-02',
    preferredDays: ['Monday', 'Wednesday', 'Friday'],
    assets: sampleAssets,
    clips: [],
  });

  assert.equal(calendar.length, 2);
  assert.notEqual(calendar[0].scheduledDate, calendar[1].scheduledDate);

  const csv = generateCalendarCsv(calendar);
  assert.ok(csv.includes('Eliminating Kubernetes Idle Tax'));

  const manifest = buildExportManifest({
    projectId: 'proj-1',
    projectName: 'Keynote Repurpose',
    brandName: 'Vanguard',
    approvedOnly: false,
    items: [
      {
        filename: 'blog.md',
        archivePath: 'keynote-repurpose/documents/blog.md',
        assetType: 'seo_blog',
        platform: 'Blog / Organic Search',
        status: 'approved',
        sourceTimestamps: 'seg-001',
        sizeBytes: 120,
        exportedAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(manifest.totalFiles, 1);

  const zip = new JSZip();
  zip.file('keynote-repurpose/documents/blog.md', formatBlogMarkdown(sampleAssets[0].structuredData as any));
  zip.file('keynote-repurpose/metadata/asset-manifest.json', JSON.stringify(manifest, null, 2));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  assert.ok(buffer.byteLength > 100);
});

test('8. Security path validation and URL access restrictions prevent unsafe operations', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etc-passwd');
  const traversalCheck = validateSafeProjectPath('/app/storage', '../../etc/passwd');
  assert.equal(traversalCheck.safe, false);

  const validPathCheck = validateSafeProjectPath('/app/storage', 'renders/clip-01.mp4');
  assert.equal(validPathCheck.safe, true);

  const ytCheck = validateUrlSourceAccess('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(ytCheck.allowed, false);
  assert.ok(ytCheck.reason.includes('restricted'));
});

test('9. Real FFmpeg media fixture creation, clip extraction, SRT synchronization, and stream verification', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ffmpeg-test-'));
  try {
    const samplePath = await ensureSampleMediaFixture(tmpDir);
    assert.equal(fs.existsSync(samplePath), true);

    const sourceProbe = await probeMediaFile(samplePath);
    assert.equal(sourceProbe.hasVideo, true);
    assert.equal(sourceProbe.hasAudio, true);
    assert.ok(sourceProbe.durationSeconds >= 88);

    const srt = generateClipSrt(FIXTURE_TRANSCRIPT, 0, 14, 8);
    assert.ok(srt.cueCount >= 2);
    assert.equal(srt.timingConfidence, 'verified');

    const renderResult = await renderVideoClipWithFfmpeg({
      sourceFilePath: samplePath,
      outputDir: tmpDir,
      clipId: 'clip-test-01',
      clipTitle: 'The 38% Kubernetes Idle Tax',
      brandLogoText: 'VANGUARD',
      onScreenHook: '38% K8s Compute Tax Explained',
      start: 0,
      end: 12,
      transcript: FIXTURE_TRANSCRIPT,
      config: {
        aspectRatio: '9:16',
        width: 360,
        height: 640,
        layoutMode: 'blurred-background',
        burnInCaptions: true,
        showBrandLogoOverlay: true,
        showHookTitleOverlay: true,
        captionStyle: {
          fontFamily: 'NotoSans-Bold',
          fontSize: 32,
          textColor: '#FFFFFF',
          backgroundColor: '#0F172ACC',
          outlineColor: '#000000',
          position: 'bottom',
          maxLineLengthChars: 28,
          maxWordsPerSegment: 7,
          highlightKeywords: ['thirty-eight'],
          safeMarginPx: 100,
        },
      },
    });

    assert.equal(fs.existsSync(renderResult.outputFilePath), true);
    assert.equal(fs.existsSync(renderResult.srtFilePath), true);
    assert.equal(renderResult.probe.hasVideo, true);
    assert.equal(renderResult.probe.hasAudio, true);
    assert.equal(renderResult.probe.width, 360);
    assert.equal(renderResult.probe.height, 640);
    assert.ok(
      renderResult.probe.durationSeconds >= 11 && renderResult.probe.durationSeconds <= 13,
      `Expected ~12s duration, got ${renderResult.probe.durationSeconds}s`
    );

    const cutCsv = generateCutSheetCsv([
      {
        id: 'clip-test-01',
        projectId: 'proj-1',
        sourceId: 'src-1',
        title: 'The 38% Kubernetes Idle Tax',
        hook: 'Hook',
        start: 0,
        end: 12,
        duration: 12,
        openingText: 'Most',
        closingText: 'clusters.',
        fullTranscript: FIXTURE_TRANSCRIPT[0].text,
        centralIdea: 'Idle tax',
        selectionReason: 'Strong stat',
        targetAudience: 'CTOs',
        recommendedPlatform: 'YouTube Shorts',
        suggestedCaption: 'Caption',
        onScreenTitle: '38% Idle Tax',
        callToAction: 'Audit now',
        editorialScores: {
          openingStrength: 95,
          contentClarity: 90,
          completeness: 88,
          audienceRelevance: 94,
          standaloneUsefulness: 91,
          productionSuitability: 92,
          overallScore: 92,
          rationale: 'Clear opening statistic',
        },
        timingConfidence: 'verified',
        sourceSegmentIds: ['seg-001'],
        boundaryValidation: {
          status: 'valid',
          warnings: [],
          cutsSentenceStart: false,
          cutsSentenceEnd: false,
          lacksStandaloneContext: false,
          withinSourceDuration: true,
          overlapsWithClipIds: [],
        },
        renderConfig: {} as any,
        renderStatus: 'ready_for_review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    assert.ok(cutCsv.includes('clip-test-01'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('10. Custom uploaded video normalization and duration-calibrated transcript indexing work end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-upload-test-'));
  try {
    const samplePath = await ensureSampleMediaFixture(tmpDir);
    const { finalPath, probe } = await ensureWebPlayableVideo(samplePath, tmpDir);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(probe.hasVideo, true);
    assert.ok(probe.durationSeconds > 10);

    const calibrated = buildDurationCalibratedTranscript({
      sourceId: 'src-upload-1',
      fileName: 'custom-product-demo.mp4',
      durationSeconds: 24,
      language: 'en',
      sourceTitle: 'Custom Product Demo',
    });
    assert.equal(calibrated.length, 3);
    assert.equal(calibrated[0].start, 0);
    assert.equal(calibrated[calibrated.length - 1].end, 24);
    assert.ok(calibrated[0].text.includes('Custom Product Demo'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('11. Parallel out-of-order chunked binary upload reassembly and instant optimistic preview work cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-chunk-test-'));
  try {
    const samplePath = await ensureSampleMediaFixture(tmpDir);
    const originalBuf = fs.readFileSync(samplePath);
    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(originalBuf.length / chunkSize);
    const reassembledPath = path.join(tmpDir, 'reassembled-podcast.mp4');

    const fdCreate = fs.openSync(reassembledPath, 'w');
    fs.closeSync(fdCreate);

    // Write chunks in reverse/out-of-order sequence to simulate parallel workers
    const indices = Array.from({ length: totalChunks }, (_, i) => i).reverse();
    for (const idx of indices) {
      const start = idx * chunkSize;
      const end = Math.min(originalBuf.length, start + chunkSize);
      const slice = originalBuf.subarray(start, end);
      const fd = fs.openSync(reassembledPath, 'r+');
      try {
        fs.writeSync(fd, slice, 0, slice.length, start);
      } finally {
        fs.closeSync(fd);
      }
    }

    const reassembledBuf = fs.readFileSync(reassembledPath);
    assert.equal(Buffer.compare(originalBuf, reassembledBuf), 0);

    const preview = buildOptimisticMediaPreview({
      projectId: 'proj-podcast-1',
      sourceId: 'src-local-1',
      fileName: 'founder-podcast-ep42.mp4',
      durationSeconds: 180,
    });
    assert.ok(preview.segments.length >= 5);
    assert.equal(preview.clips.length, 3);
    assert.equal(preview.segments[preview.segments.length - 1].end, 180);
    for (const c of preview.clips) {
      assert.ok(
        c.duration <= SHORT_FORM_MAX_DURATION_SEC,
        `Expected clip duration <= 120s, got ${c.duration}s`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('12. Short-form clip duration clamping enforces <= 120s maximum for Instagram Reels and YouTube Shorts', () => {
  const longRecordingSec = 3952.2;
  const fineSegments = buildDurationCalibratedTranscript({
    sourceId: 'src-vikas',
    fileName: 'Vikas-Divyakirti-on-SnapYT.App.mp4',
    durationSeconds: longRecordingSec,
    language: 'hi',
    sourceTitle: 'Vikas Divyakirti Lecture',
  });

  assert.ok(fineSegments.length >= 60);
  assert.ok(fineSegments[0].end - fineSegments[0].start <= 30);

  const clamped = clampClipIntervalToShortForm({
    start: 0,
    end: 1317.4,
    sourceDurationSec: longRecordingSec,
    maxAllowedSec: 60,
    minAllowedSec: 18,
    transcript: fineSegments,
  });

  assert.equal(clamped.clamped, true);
  assert.ok(clamped.duration <= 60);
  assert.ok(clamped.duration <= SHORT_FORM_MAX_DURATION_SEC);
  assert.ok(clamped.matchedSegmentIds.length >= 1);

  const customClip = createClipFromTranscriptSelection({
    projectId: 'aifbgvaer',
    sourceId: 'src-vikas',
    selectedSegments: fineSegments.slice(0, 15),
    allSegments: fineSegments,
    sourceDurationSec: longRecordingSec,
    maxDurationSec: 120,
  });
  assert.ok(customClip.duration <= SHORT_FORM_MAX_DURATION_SEC);
});

test('13. Operational error sanitizer strips raw FFmpeg CLI commands, compiler flags, and Windows path leaks', () => {
  const rawFfmpegDump = `Clip clip-01 render failed: Command failed: ffmpeg -y -ss 0 -to 1317.4 -i /app/applet/D:\\StrataStudio\\storage/uploads/1793333722854-Vikas-Divyakirti-on-SnapYT.App.mp4 -filter_complex "[0:v]split=2[bg][fg]" ffmpeg version 4.4.2-0ubuntu0.22.04.1+esm17 Copyright (c) 2000-2021 the FFmpeg developers built with gcc 11 configuration: --prefix=/usr --extra-version=0ubuntu0.22.04.1 --enable-gpl --enable-libx264`;

  const diag = sanitizeOperationalError({
    projectId: 'aifbgvaer',
    stage: 'video_render',
    clipId: 'clip-01',
    rawError: rawFfmpegDump,
  });

  assert.equal(diag.userMessage.includes('Command failed: ffmpeg'), false);
  assert.equal(diag.userMessage.includes('--enable-gpl'), false);
  assert.equal(diag.userMessage.includes('D:\\StrataStudio'), false);
  assert.ok(diag.technicalDetails.includes('configuration:'));
});

test('14. Environment storage path resolver maps Windows D:\\ paths safely to POSIX storage on Linux', () => {
  const resolved = resolveEnvironmentStoragePaths(
    'D:\\StrataStudio\\storage',
    'linux',
    '/app/applet'
  );
  assert.equal(resolved.isFallbackFromWindowsPath, true);
  assert.equal(resolved.activePath, '/app/applet/storage');
  assert.equal(resolved.configuredPath, 'D:\\StrataStudio\\storage');
});

test('15. Chunked multilingual transcript merging and coverage report verify full recording coverage', () => {
  const chunkA: TranscriptSegment[] = [
    {
      id: 'c1-1',
      sourceId: 'src-1',
      start: 0,
      end: 15,
      text: 'नमस्ते दोस्तों, आज हम साहित्य और जीवन के संबंध पर बात करेंगे।',
      speakerId: 'Speaker 1 (Dr. Vikas Divyakirti)',
      language: 'hi',
      confidence: 0.96,
      timingVerified: true,
    },
  ];
  const chunkB: TranscriptSegment[] = [
    {
      id: 'c2-1',
      sourceId: 'src-1',
      start: 15,
      end: 30,
      text: 'When we examine philosophical texts in Hindi and English, context matters.',
      speakerId: 'Speaker 1 (Dr. Vikas Divyakirti)',
      language: 'hi',
      confidence: 0.95,
      timingVerified: true,
    },
  ];

  const merged = mergeChunkedTranscriptSegments([chunkA, chunkB], 'src-1');
  assert.equal(merged.length, 2);
  assert.equal(merged[0].start, 0);
  assert.equal(merged[1].end, 30);

  const report = computeTranscriptCoverageReport(merged, 30, 2);
  assert.equal(report.coveragePercent, 100);
  assert.equal(report.chunkCount, 2);
  assert.equal(report.speakerCount, 1);
});

test('16. Romanised transcription transliterates Hindi & Gujarati accurately and preserves code-switching without forced translation', () => {
  assert.equal(
    romaniseIndianAndNonLatinText('कुछ नहीं होता', 'hi').romanised,
    'Kuch nahi hota'
  );
  assert.equal(
    romaniseIndianAndNonLatinText('मुझे समझ में नहीं आया', 'hi').romanised,
    'Mujhe samajh mein nahi aaya'
  );
  assert.equal(
    romaniseIndianAndNonLatinText('यह बहुत अच्छा है', 'hi').romanised,
    'Yeh bahut achha hai'
  );
  assert.equal(
    romaniseIndianAndNonLatinText('आप कैसे हैं?', 'hi').romanised,
    'Aap kaise hain?'
  );

  // Code-switching preservation
  const mixed = romaniseIndianAndNonLatinText(
    'Basically, जब हम अवधारणा (concept) को समझते हैं, this is a very good idea.',
    'hi'
  );
  assert.equal(mixed.hasCodeSwitching, true);
  assert.ok(mixed.romanised.includes('Basically'));
  assert.ok(mixed.romanised.includes('this is a very good idea'));
  assert.ok(mixed.romanised.toLowerCase().includes('avdharana'));

  // Gujarati transliteration
  const guj = romaniseIndianAndNonLatinText('આ સત્રમાં આપણે વિષય ચર્ચા કરીશું', 'gu');
  assert.ok(guj.romanised.toLowerCase().includes('satrama'));
  assert.ok(guj.romanised.toLowerCase().includes('vishay'));
});

test('17. Caption script mode selection generates Original, Romanised, Both, and Translation SRT subtitles accurately', () => {
  const rawSegments: TranscriptSegment[] = [
    {
      id: 'seg-1',
      sourceId: 'src-1',
      start: 0,
      end: 10,
      text: 'कुछ नहीं होता',
      translatedText: 'Nothing happens',
      speakerId: 'Speaker 1',
      language: 'hi',
      confidence: 0.96,
      timingVerified: true,
    },
  ];
  const enriched = enrichTranscriptWithRomanisation(rawSegments, 'hi');
  assert.equal(enriched[0].originalText, 'कुछ नहीं होता');
  assert.equal(enriched[0].romanisedText, 'Kuch nahi hota');

  const srtOrig = generateClipSrt(enriched, 0, 10, 10, 'original');
  assert.ok(srtOrig.srtContent.includes('कुछ नहीं होता'));

  const srtRom = generateClipSrt(enriched, 0, 10, 10, 'romanised');
  assert.ok(srtRom.srtContent.includes('Kuch nahi hota'));

  const srtBoth = generateClipSrt(enriched, 0, 10, 10, 'both');
  assert.ok(srtBoth.srtContent.includes('कुछ नहीं होता / Kuch nahi hota'));

  const srtTrans = generateClipSrt(enriched, 0, 10, 10, 'translation');
  assert.ok(srtTrans.srtContent.includes('Nothing happens'));
});

test('18. Smart vertical video composition detector and crop validator enforce valid mobile framing', () => {
  const multiSpeaker = detectSmartVideoComposition({
    sourceType: 'Podcast',
    width: 1280,
    height: 720,
    speakerCount: 2,
  });
  assert.equal(multiSpeaker.recommendedMode, 'dynamic-speaker');
  assert.equal(multiSpeaker.sceneType, 'multi_speaker');

  const presentation = detectSmartVideoComposition({
    sourceType: 'Webinar',
    width: 1920,
    height: 1080,
    speakerCount: 1,
  });
  assert.equal(presentation.recommendedMode, 'picture-in-picture');

  const cropCheck = validateVerticalCompositionCrop({
    config: {
      aspectRatio: '9:16',
      width: 540,
      height: 960,
      layoutMode: 'manual-reframe',
      manualCrop: { horizontalOffset: 20, verticalOffset: -10, zoom: 1.25 },
      burnInCaptions: true,
      showBrandLogoOverlay: true,
      showHookTitleOverlay: true,
      captionStyle: {
        fontFamily: 'NotoSans-Bold',
        fontSize: 28,
        textColor: '#FFFFFF',
        backgroundColor: '#0F172A',
        outlineColor: '#000000',
        position: 'bottom',
        maxLineLengthChars: 30,
        maxWordsPerSegment: 7,
        highlightKeywords: [],
        safeMarginPx: 90,
      },
    },
    sourceWidth: 1280,
    sourceHeight: 720,
  });
  assert.equal(cropCheck.valid, true);
  assert.equal(cropCheck.aspectRatioPreserved, true);
  assert.equal(cropCheck.noStretching, true);
});

test('19. Smart short-video word highlighter and multi-segment highlight stitcher build cohesive reels', async () => {
  const {
    extractImpactHighlightWords,
    buildSmartStitchedClipIntervals,
    PAY_AS_YOU_GO_CREDIT_PACKS,
    OPERATION_CREDIT_RATES,
  } = await import('./coreLogic');

  const highlights = extractImpactHighlightWords(
    'Most enterprise engineering teams pay a 38% idle compute tax on Kubernetes clusters.',
    ['Kubernetes']
  );
  assert.ok(highlights.length >= 2);
  assert.ok(highlights.includes('38%'));

  const stitched = buildSmartStitchedClipIntervals({
    selectedSegments: [FIXTURE_TRANSCRIPT[0], FIXTURE_TRANSCRIPT[2]],
    sourceDurationSec: 90,
    maxTotalDurationSec: 120,
  });
  assert.equal(stitched.intervals.length, 2);
  assert.equal(stitched.totalDurationSec, 30);
  assert.ok(stitched.combinedTranscript.includes('Kubernetes'));
  assert.ok(stitched.combinedTranscript.includes('three hundred percent'));

  assert.equal(PAY_AS_YOU_GO_CREDIT_PACKS.length, 3);
  assert.ok(OPERATION_CREDIT_RATES.smart_stitch_render > 0);
});


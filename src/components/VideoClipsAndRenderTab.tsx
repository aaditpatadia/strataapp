import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Film,
  HelpCircle,
  Keyboard,
  Layers,
  Maximize2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Sliders,
  Sparkles,
  Video,
  Volume2,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { fetchJson } from '../lib/apiClient';
import {
  buildClipContextRecommendations,
  clampClipIntervalToShortForm,
  detectSmartVideoComposition,
  enrichTranscriptWithRomanisation,
  formatTimestamp,
  generateClipSrt,
  sanitizeOperationalError,
  SHORT_FORM_MAX_DURATION_SEC,
  validateVerticalCompositionCrop,
} from '../lib/coreLogic';
import type {
  CaptionScriptMode,
  FullProjectBundle,
  ManualCropConfig,
  VideoClipCandidate,
  VideoLayoutMode,
} from '../types/domain';
import {
  DiagnosticAlertCard,
  PersistentMediaInspector,
} from './PersistentMediaInspector';

interface VideoClipsProps {
  bundle: FullProjectBundle;
  geminiConfigured: boolean;
  localPreviewUrl?: string | null;
  localPreviewName?: string | null;
  onDiscoverClips: (useDeterministicFallback: boolean) => Promise<void>;
  onUpdateClip: (
    clipId: string,
    payload: Record<string, any>
  ) => Promise<void>;
  onRenderClipFfmpeg: (clipId: string) => Promise<void>;
  onRefreshBundle?: () => Promise<void>;
  onNavigateSection: (section: string) => void;
}

const COMPOSITION_MODES: Array<{
  id: VideoLayoutMode;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    id: 'smart-crop',
    label: '1. Smart Crop (Subject-Centered 9:16)',
    badge: 'Auto Subject',
    description:
      'Centers the primary subject in a 9:16 vertical frame without black bars or distortion.',
  },
  {
    id: 'speaker-focus',
    label: '2. Speaker Focus Crop (Upper-Body Portrait)',
    badge: 'Talking Head',
    description:
      'Frames the active speaker with balanced headroom for podcasts, interviews, and keynotes.',
  },
  {
    id: 'dynamic-speaker',
    label: '3. Dynamic Speaker Switching (Dialogue)',
    badge: 'Multi-Speaker',
    description:
      'Smoothly shifts horizontal framing across speaker turns without rapid jitter.',
  },
  {
    id: 'blurred-background',
    label: '4. Blurred Background Frame (Wide Context)',
    badge: 'Full Context',
    description:
      'Places the full 16:9 frame over a soft-blurred vertical backdrop when wide visuals matter.',
  },
  {
    id: 'split-screen',
    label: '5. Split-Screen Layout (Top Context / Bottom Speaker)',
    badge: 'Dual Stack',
    description:
      'Stacks wide presentation context on top and zoomed speaker framing on the bottom.',
  },
  {
    id: 'picture-in-picture',
    label: '6. Picture-in-Picture (Screen + Speaker Overlay)',
    badge: 'PiP Demo',
    description:
      'Displays screen share or slide deck with a crisp speaker inset in the lower safe corner.',
  },
  {
    id: 'manual-reframe',
    label: '7. Manual Crop & Reframe (Custom X / Y / Zoom)',
    badge: 'Precision',
    description:
      'Direct horizontal X, vertical Y, and zoom control with real-time crop validation.',
  },
];

export const VideoClipsAndRenderSection: React.FC<VideoClipsProps> = ({
  bundle,
  geminiConfigured,
  localPreviewUrl,
  localPreviewName,
  onDiscoverClips,
  onUpdateClip,
  onRenderClipFfmpeg,
  onRefreshBundle,
  onNavigateSection,
}) => {
  const { project, clips, source, transcript, renderJobs } = bundle;
  const enrichedTranscript = React.useMemo(
    () => enrichTranscriptWithRomanisation(transcript, project.sourceLanguage),
    [transcript, project.sourceLanguage]
  );

  const [selectedClipId, setSelectedClipId] = useState<string>(
    clips[0]?.id || ''
  );
  const [batchSelectedClipIds, setBatchSelectedClipIds] = useState<string[]>([]);

  const activeClip =
    clips.find((c) => c.id === selectedClipId) || clips[0];

  const [startSec, setStartSec] = useState<number>(activeClip?.start ?? 0);
  const [endSec, setEndSec] = useState<number>(activeClip?.end ?? 45);
  const [clipTitle, setClipTitle] = useState<string>(activeClip?.title || '');
  const [onScreenTitle, setOnScreenTitle] = useState<string>(
    activeClip?.onScreenTitle || ''
  );
  const [recommendedPlatform, setRecommendedPlatform] = useState<string>(
    activeClip?.recommendedPlatform || 'YouTube Shorts'
  );
  const [captionText, setCaptionText] = useState<string>(
    activeClip?.suggestedCaption || ''
  );
  const [aspectRatio, setAspectRatio] = useState<
    '9:16' | '1:1' | '16:9' | 'original'
  >(activeClip?.renderConfig?.aspectRatio || '9:16');
  const [layoutMode, setLayoutMode] = useState<VideoLayoutMode>(
    activeClip?.renderConfig?.layoutMode || 'smart-crop'
  );
  const [captionScriptMode, setCaptionScriptMode] = useState<CaptionScriptMode>(
    activeClip?.renderConfig?.captionScriptMode ||
      project.config.defaultCaptionScriptMode ||
      'romanised'
  );
  const [manualCrop, setManualCrop] = useState<ManualCropConfig>(
    activeClip?.renderConfig?.manualCrop || {
      horizontalOffset: 0,
      verticalOffset: -10,
      zoom: 1.08,
    }
  );
  const [burnInCaptions, setBurnInCaptions] = useState<boolean>(
    activeClip?.renderConfig?.burnInCaptions ?? true
  );
  const [showLogo, setShowLogo] = useState<boolean>(
    activeClip?.renderConfig?.showBrandLogoOverlay ?? true
  );
  const [showHookBanner, setShowHookBanner] = useState<boolean>(
    activeClip?.renderConfig?.showHookTitleOverlay ?? true
  );
  const [enableWordHighlighting, setEnableWordHighlighting] = useState<boolean>(
    activeClip?.renderConfig?.enableWordHighlighting ?? true
  );
  const [enableAudioNormalization, setEnableAudioNormalization] = useState<boolean>(
    activeClip?.renderConfig?.enableAudioNormalization ?? true
  );
  const [enableSilenceTrimming, setEnableSilenceTrimming] = useState<boolean>(
    activeClip?.renderConfig?.enableSilenceTrimming ?? false
  );
  const [stitchSegmentIds, setStitchSegmentIds] = useState<string[]>(
    activeClip?.renderConfig?.stitchedSegments?.map((s) => s.id) ||
      enrichedTranscript.slice(0, 2).map((s) => s.id)
  );
  const [showShortcutsTooltip, setShowShortcutsTooltip] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(
    activeClip?.renderConfig?.captionStyle?.fontSize || 36
  );
  const [captionPos, setCaptionPos] = useState<'bottom' | 'center' | 'top'>(
    activeClip?.renderConfig?.captionStyle?.position || 'bottom'
  );
  const [maxWordsPerSegment, setMaxWordsPerSegment] = useState<number>(
    activeClip?.renderConfig?.captionStyle?.maxWordsPerSegment || 7
  );

  // Visual Preview Zoom for Rendered/Composition Inspector (Priority 4)
  const [outputPreviewZoom, setOutputPreviewZoom] = useState<number>(1);

  const [busy, setBusy] = useState(false);
  const [renderingId, setRenderingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'info' | 'error' | 'success';
    text: string;
  } | null>(null);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const renderedVideoRef = useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    if (activeClip) {
      setStartSec(activeClip.start);
      setEndSec(activeClip.end);
      setClipTitle(activeClip.title);
      setOnScreenTitle(activeClip.onScreenTitle);
      setRecommendedPlatform(activeClip.recommendedPlatform || 'YouTube Shorts');
      setCaptionText(activeClip.suggestedCaption);
      setAspectRatio(activeClip.renderConfig?.aspectRatio || '9:16');
      setLayoutMode(activeClip.renderConfig?.layoutMode || 'smart-crop');
      setCaptionScriptMode(
        activeClip.renderConfig?.captionScriptMode ||
          project.config.defaultCaptionScriptMode ||
          'romanised'
      );
      setManualCrop(
        activeClip.renderConfig?.manualCrop || {
          horizontalOffset: 0,
          verticalOffset: -10,
          zoom: 1.08,
        }
      );
      setBurnInCaptions(activeClip.renderConfig?.burnInCaptions ?? true);
      setShowLogo(activeClip.renderConfig?.showBrandLogoOverlay ?? true);
      setShowHookBanner(activeClip.renderConfig?.showHookTitleOverlay ?? true);
      setEnableWordHighlighting(
        activeClip.renderConfig?.enableWordHighlighting ?? true
      );
      setEnableAudioNormalization(
        activeClip.renderConfig?.enableAudioNormalization ?? true
      );
      setEnableSilenceTrimming(
        activeClip.renderConfig?.enableSilenceTrimming ?? false
      );
      if (
        activeClip.renderConfig?.stitchedSegments &&
        activeClip.renderConfig.stitchedSegments.length >= 2
      ) {
        setStitchSegmentIds(
          activeClip.renderConfig.stitchedSegments.map((s) => s.id)
        );
      }
      setFontSize(activeClip.renderConfig?.captionStyle?.fontSize || 36);
      setCaptionPos(
        activeClip.renderConfig?.captionStyle?.position || 'bottom'
      );
      setMaxWordsPerSegment(
        activeClip.renderConfig?.captionStyle?.maxWordsPerSegment || 7
      );
    }
  }, [activeClip?.id, activeClip?.sourceId, activeClip?.updatedAt]);

  // Keyboard shortcuts for the VideoClipsAndRenderSection player
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const vid = renderedVideoRef.current || sourceVideoRef.current;
      const key = e.key;

      if (key === '?') {
        e.preventDefault();
        setShowShortcutsTooltip((prev) => !prev);
        return;
      }
      if (key === 'Escape' && showShortcutsTooltip) {
        setShowShortcutsTooltip(false);
        return;
      }
      if (!vid) return;

      if (key === ' ' || key.toLowerCase() === 'k') {
        e.preventDefault();
        if (vid.paused) {
          vid.play().catch(() => {});
        } else {
          vid.pause();
        }
      } else if (key.toLowerCase() === 'j') {
        e.preventDefault();
        vid.currentTime = Math.max(0, vid.currentTime - 5);
      } else if (key.toLowerCase() === 'l') {
        e.preventDefault();
        vid.currentTime = Math.min(vid.duration || 9999, vid.currentTime + 5);
      } else if (key === ',') {
        e.preventDefault();
        vid.pause();
        vid.currentTime = Math.max(0, vid.currentTime - 1 / 24);
      } else if (key === '.') {
        e.preventDefault();
        vid.pause();
        vid.currentTime = Math.min(vid.duration || 9999, vid.currentTime + 1 / 24);
      } else if (key.toLowerCase() === 'm') {
        e.preventDefault();
        vid.muted = !vid.muted;
      } else if (key.toLowerCase() === 'f') {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          vid.requestFullscreen?.().catch(() => {});
        }
      } else if (key === '[') {
        e.preventDefault();
        setStartSec((s) => Math.max(0, Math.round((s - 0.5) * 10) / 10));
      } else if (key === ']') {
        e.preventDefault();
        setEndSec((endVal) =>
          Math.min(
            source?.mediaDurationSeconds || 120,
            Math.round((endVal + 0.5) * 10) / 10
          )
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showShortcutsTooltip, source?.mediaDurationSeconds]);

  const speakerCountInClip = React.useMemo(() => {
    const overlapping = enrichedTranscript.filter(
      (s) => s.end > startSec && s.start < endSec
    );
    const sp = new Set(
      overlapping.map((s) => s.speaker || s.speakerId).filter(Boolean)
    );
    return Math.max(1, sp.size);
  }, [enrichedTranscript, startSec, endSec]);

  const smartCompositionAnalysis = React.useMemo(
    () =>
      detectSmartVideoComposition({
        sourceType: project.sourceType,
        width: source?.width || 1280,
        height: source?.height || 720,
        speakerCount: speakerCountInClip,
      }),
    [
      source?.width,
      source?.height,
      speakerCountInClip,
      project.sourceType,
    ]
  );

  const cropValidation = React.useMemo(
    () =>
      validateVerticalCompositionCrop({
        config: {
          aspectRatio,
          width:
            aspectRatio === '16:9'
              ? 1280
              : aspectRatio === '1:1'
                ? 720
                : aspectRatio === 'original'
                  ? source?.width || 1280
                  : 540,
          height:
            aspectRatio === '16:9'
              ? 720
              : aspectRatio === '1:1'
                ? 720
                : aspectRatio === 'original'
                  ? source?.height || 720
                  : 960,
          layoutMode,
          manualCrop,
          burnInCaptions,
          showBrandLogoOverlay: showLogo,
          showHookTitleOverlay: showHookBanner,
          captionStyle: {
            ...(activeClip?.renderConfig?.captionStyle || {
              fontSize: 36,
              primaryColor: '#FFFFFF',
              highlightColor: '#3B82F6',
              position: 'bottom',
              maxWordsPerSegment: 7,
              safeMarginPx: 90,
            }),
            position: captionPos,
          },
        },
        sourceWidth: source?.width || 1280,
        sourceHeight: source?.height || 720,
      }),
    [
      activeClip?.renderConfig?.captionStyle,
      source?.width,
      source?.height,
      aspectRatio,
      layoutMode,
      manualCrop,
      burnInCaptions,
      showLogo,
      showHookBanner,
      captionPos,
    ]
  );

  const aiRecommendations = React.useMemo(() => {
    if (!activeClip) return null;
    return (
      activeClip.contextRecommendations ||
      buildClipContextRecommendations({
        clip: {
          ...activeClip,
          title: clipTitle || activeClip.title,
          duration: Math.max(1, endSec - startSec),
          recommendedPlatform: recommendedPlatform as any,
        },
        projectObjective: project.primaryObjective,
        targetAudience: project.targetAudience,
      })
    );
  }, [
    activeClip,
    clipTitle,
    project.primaryObjective,
    project.targetAudience,
    recommendedPlatform,
    startSec,
    endSec,
  ]);

  const handleAutoDetectSmartFraming = () => {
    setLayoutMode(smartCompositionAnalysis.recommendedMode);
    setManualCrop({
      horizontalOffset: smartCompositionAnalysis.cropX,
      verticalOffset: smartCompositionAnalysis.cropY,
      zoom: smartCompositionAnalysis.zoom,
      subjectSceneType: smartCompositionAnalysis.sceneType,
    });
    setFeedback({
      type: 'info',
      text: `Smart Scene Analysis: Selected "${smartCompositionAnalysis.recommendedMode}" (${speakerCountInClip} speaker(s) in interval). ${smartCompositionAnalysis.explanation}`,
    });
  };

  const handleResetFraming = () => {
    setLayoutMode('smart-crop');
    setManualCrop({
      horizontalOffset: 0,
      verticalOffset: -10,
      zoom: 1.0,
    });
    setOutputPreviewZoom(1);
  };

  const applyDurationPreset = (targetDurSec: number) => {
    const clamped = clampClipIntervalToShortForm({
      start: startSec,
      end: startSec + targetDurSec,
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      maxDurationSec: SHORT_FORM_MAX_DURATION_SEC,
    });
    setStartSec(clamped.start);
    setEndSec(clamped.end);
  };

  const buildRenderConfigPayload = (baseClip: VideoClipCandidate) => ({
    aspectRatio,
    width:
      aspectRatio === '16:9'
        ? 1280
        : aspectRatio === '1:1'
          ? 720
          : aspectRatio === 'original'
            ? source?.width || 1280
            : 540,
    height:
      aspectRatio === '16:9'
        ? 720
        : aspectRatio === '1:1'
          ? 720
          : aspectRatio === 'original'
            ? source?.height || 720
            : 960,
    layoutMode,
    captionScriptMode,
    manualCrop,
    cropValidation,
    burnInCaptions,
    showBrandLogoOverlay: showLogo,
    showHookTitleOverlay: showHookBanner,
    enableWordHighlighting,
    enableAudioNormalization,
    enableSilenceTrimming,
    stitchedSegments: baseClip.renderConfig?.stitchedSegments,
    captionStyle: {
      ...baseClip.renderConfig.captionStyle,
      fontSize: Number(fontSize),
      position: captionPos,
      maxWordsPerSegment: Number(maxWordsPerSegment),
    },
  });

  const toggleStitchSegment = (segId: string) => {
    setStitchSegmentIds((prev) =>
      prev.includes(segId) ? prev.filter((id) => id !== segId) : [...prev, segId]
    );
  };

  const handleCreateSmartStitchedClip = async () => {
    if (stitchSegmentIds.length < 2) {
      setFeedback({
        type: 'error',
        text: 'Select at least 2 transcript segments to stitch into a smart multi-segment short.',
      });
      return;
    }
    setBusy(true);
    setFeedback({
      type: 'info',
      text: `Creating Smart Stitched Short from ${stitchSegmentIds.length} transcript segments...`,
    });
    try {
      const data = await fetchJson<{ clip: VideoClipCandidate }>(
        `/api/projects/${project.id}/clips/smart-stitch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segmentIds: stitchSegmentIds,
            recommendedPlatform,
          }),
        }
      );
      await onRefreshBundle?.();
      if (data?.clip?.id) {
        setSelectedClipId(data.clip.id);
      }
      setFeedback({
        type: 'success',
        text: `Created "${data?.clip?.title || 'Smart Stitched Short'}" (${data?.clip?.duration || 30}s) with multi-segment FFmpeg concatenation, active word highlights, and -16 LUFS audio normalization! Click "Render Clip (FFmpeg)" to encode.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveBoundariesAndConfig = async (
    nextStatus?: VideoClipCandidate['renderStatus']
  ) => {
    if (!activeClip) return;
    setBusy(true);
    setFeedback(null);
    const clamped = clampClipIntervalToShortForm({
      start: Number(startSec),
      end: Number(endSec),
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      maxDurationSec: SHORT_FORM_MAX_DURATION_SEC,
    });
    setStartSec(clamped.start);
    setEndSec(clamped.end);

    try {
      await onUpdateClip(activeClip.id, {
        start: clamped.start,
        end: clamped.end,
        title: clipTitle,
        onScreenTitle,
        recommendedPlatform,
        suggestedCaption: captionText,
        renderStatus: nextStatus,
        renderConfig: buildRenderConfigPayload(activeClip),
      });
      setFeedback({
        type: 'success',
        text:
          nextStatus === 'approved'
            ? `Approved Clip "${clipTitle}" for export.`
            : `Saved framing (${layoutMode}, ${aspectRatio}, ${captionScriptMode} captions) and boundaries (${clamped.start}s – ${clamped.end}s) for ${activeClip.id}.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleApplyFramingToSelectedClips = async () => {
    const targetIds =
      batchSelectedClipIds.length > 0
        ? batchSelectedClipIds
        : clips.map((c) => c.id);
    setBusy(true);
    setFeedback(null);
    try {
      await fetchJson(`/api/projects/${project.id}/clips/batch-framing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipIds: targetIds,
          aspectRatio,
          layoutMode,
          manualCrop,
          captionScriptMode,
        }),
      });
      await onRefreshBundle?.();
      setFeedback({
        type: 'success',
        text: `Applied ${layoutMode} (${aspectRatio}) framing and ${captionScriptMode} caption script mode to ${targetIds.length} clip(s).`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleBatchApproveSelected = async () => {
    const targetIds =
      batchSelectedClipIds.length > 0
        ? batchSelectedClipIds
        : clips.map((c) => c.id);
    setBusy(true);
    try {
      await fetchJson(`/api/projects/${project.id}/batch-approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds: targetIds }),
      });
      await onRefreshBundle?.();
      setFeedback({
        type: 'success',
        text: `Approved ${targetIds.length} clip(s) for delivery export.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewSourceInterval = () => {
    const vid = sourceVideoRef.current;
    if (!vid) return;
    vid.currentTime = Math.max(0, startSec);
    vid.play().catch(() => {});
    const checkEnd = () => {
      if (vid.currentTime >= endSec) {
        vid.pause();
        vid.removeEventListener('timeupdate', checkEnd);
      }
    };
    vid.addEventListener('timeupdate', checkEnd);
  };

  const handleTriggerRender = async (clip: VideoClipCandidate) => {
    setRenderingId(clip.id);
    const clamped = clampClipIntervalToShortForm({
      start: Number(startSec),
      end: Number(endSec),
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      maxDurationSec: SHORT_FORM_MAX_DURATION_SEC,
    });
    setStartSec(clamped.start);
    setEndSec(clamped.end);

    setFeedback({
      type: 'info',
      text: `Submitting ${clip.id} (${formatTimestamp(clamped.start)} – ${formatTimestamp(clamped.end)}, ${clamped.duration}s, ${aspectRatio} ${layoutMode}) to staged FFmpeg render pipeline...`,
    });
    try {
      await onUpdateClip(clip.id, {
        start: clamped.start,
        end: clamped.end,
        title: clipTitle,
        onScreenTitle,
        recommendedPlatform,
        suggestedCaption: captionText,
        renderConfig: buildRenderConfigPayload(clip),
      });
      await onRenderClipFfmpeg(clip.id);
      setFeedback({
        type: 'success',
        text: `Render job processed for ${clip.id}! Output verified and loaded in the Rendered Output Player.`,
      });
    } catch (err: any) {
      const diag = sanitizeOperationalError({
        stage: 'video_render',
        rawError: err.message || 'Render error',
        clipId: clip.id,
      });
      setFeedback({
        type: 'error',
        text: diag.userMessage,
      });
    } finally {
      setRenderingId(null);
    }
  };

  const handleQueueBatchRender = async (onlySelected?: boolean) => {
    const targetIds =
      onlySelected && batchSelectedClipIds.length > 0
        ? batchSelectedClipIds
        : clips.map((c) => c.id);
    setBusy(true);
    setFeedback({
      type: 'info',
      text: `Queuing ${targetIds.length} short-form clip(s) for sequential FFmpeg rendering...`,
    });
    try {
      await fetchJson(`/api/projects/${project.id}/clips/render-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipIds: targetIds,
        }),
      });
      await onRefreshBundle?.();
      setFeedback({
        type: 'success',
        text: `Queued ${targetIds.length} clip(s) in the Render Queue. Jobs execute automatically within the concurrency limit.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelRender = async (clipId: string) => {
    setBusy(true);
    try {
      await fetchJson(
        `/api/projects/${project.id}/clips/${clipId}/cancel-render`,
        { method: 'POST' }
      );
      await onRefreshBundle?.();
      setFeedback({
        type: 'info',
        text: `Cancelled render job for ${clipId} and released queue slot.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateFailureRecovery = async (clipId: string) => {
    setBusy(true);
    setFeedback({
      type: 'info',
      text: `Testing failure recovery on ${clipId}: forcing a simulated error to verify slot release and next-job continuation...`,
    });
    try {
      await fetchJson(`/api/projects/${project.id}/clips/${clipId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceFailForTest: true }),
      });
    } catch {
      // Expected 422 from simulated failure
    } finally {
      await onRefreshBundle?.();
      setBusy(false);
      setFeedback({
        type: 'info',
        text: `Simulated failure recorded on ${clipId}. Execution slot was released cleanly — click "Retry Render" to render the valid MP4.`,
      });
    }
  };

  const toggleBatchClipSelection = (id: string) => {
    setBatchSelectedClipIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const liveSrtPreview = activeClip
    ? generateClipSrt(
        enrichedTranscript,
        Number(startSec),
        Number(endSec),
        Number(maxWordsPerSegment),
        captionScriptMode
      )
    : null;

  const activeOrQueuedCount = clips.filter(
    (c) => c.renderStatus === 'processing' || c.renderStatus === 'queued'
  ).length;

  const totalSourceDuration = Math.max(
    1,
    source?.mediaDurationSeconds ||
      enrichedTranscript[enrichedTranscript.length - 1]?.end ||
      90
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Steps 7 & 8: Intelligent Vertical Video Composition (7 Modes) · Romanised Captions · Staged FFmpeg Pipeline
          </p>
          <h2 className="text-xl font-bold text-slate-900">
            Short-Form Video Clips & FFmpeg Render Studio ({clips.length})
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDiscoverClips(!geminiConfigured)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Discover Short Clips (≤120s)
          </button>
          {clips.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => handleQueueBatchRender(false)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50"
            >
              <Film className="w-3.5 h-3.5" />
              Queue All Clips ({clips.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigateSection('calendar')}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Proceed to Content Calendar
          </button>
        </div>
      </div>

      {/* Persistent Source Media Inspector with Active Clip Window */}
      <PersistentMediaInspector
        source={source}
        localPreviewUrl={localPreviewUrl}
        localPreviewName={localPreviewName}
        intervalStartSec={startSec}
        intervalEndSec={endSec}
        compact
        title="06. Video Clips — Master Source Video & Active Clip Interval Scrubber"
      />

      {/* Priority 4: Interactive Multi-Clip Source Timeline Bar */}
      {clips.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-bold text-slate-900">
              Interactive Clip Timeline ({formatTimestamp(totalSourceDuration)} Total Source Recording)
            </span>
            <span className="font-mono text-slate-500">
              Active Clip Window: {formatTimestamp(startSec)} – {formatTimestamp(endSec)} ({Math.max(1, Math.round(endSec - startSec))}s / 120s Max)
            </span>
          </div>
          <div className="relative h-8 bg-slate-100 border border-slate-200 rounded overflow-hidden">
            {clips.map((c, idx) => {
              const leftPct = Math.min(
                98,
                Math.max(0, (c.start / totalSourceDuration) * 100)
              );
              const widthPct = Math.min(
                100 - leftPct,
                Math.max(2.5, ((c.end - c.start) / totalSourceDuration) * 100)
              );
              const isCurrent = c.id === activeClip?.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedClipId(c.id)}
                  title={`#${idx + 1} ${c.title} (${formatTimestamp(c.start)} – ${formatTimestamp(c.end)})`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  className={`absolute top-1 bottom-1 rounded text-[10px] font-mono font-bold px-1 truncate transition-all ${
                    isCurrent
                      ? 'bg-blue-600 text-white z-10 ring-2 ring-slate-900'
                      : 'bg-slate-300/80 text-slate-800 hover:bg-slate-400'
                  }`}
                >
                  #{idx + 1}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Batch Operations Action Bar (Priority 8) */}
      {batchSelectedClipIds.length > 0 && (
        <div className="bg-slate-900 text-white rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-semibold">
            {batchSelectedClipIds.length} clip(s) selected for batch operations
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleQueueBatchRender(true)}
              className="px-3 py-1.5 font-semibold bg-blue-600 text-white rounded hover:bg-blue-500"
            >
              Render Selected ({batchSelectedClipIds.length})
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleApplyFramingToSelectedClips}
              className="px-3 py-1.5 font-semibold bg-slate-800 border border-slate-700 text-white rounded hover:bg-slate-700"
            >
              Apply Current Framing ({layoutMode})
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleBatchApproveSelected}
              className="px-3 py-1.5 font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-500"
            >
              Approve Selected
            </button>
            <button
              type="button"
              onClick={() => setBatchSelectedClipIds([])}
              className="px-2 py-1 text-slate-400 hover:text-white"
            >
              Clear Selection
            </button>
          </div>
        </div>
      )}

      {/* Queue Status Banner when jobs are queued or processing */}
      {activeOrQueuedCount > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-950">
          <div className="flex items-center gap-2 font-semibold">
            <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
            <span>
              Render Queue Active: {activeOrQueuedCount} clip(s) currently queued or processing. Waiting jobs automatically start as each slot frees up.
            </span>
          </div>
          <span className="font-mono text-[11px] bg-blue-100 px-2 py-0.5 rounded">
            Auto-refreshing queue state
          </span>
        </div>
      )}

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-xs font-medium ${
            feedback.type === 'error'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : feedback.type === 'info'
                ? 'bg-blue-50 border-blue-200 text-blue-900'
                : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Sanitized Diagnostic Card if Active Clip Failed */}
      {activeClip?.renderStatus === 'failed' && (
        <DiagnosticAlertCard
          title={`Clip Render Failed: ${activeClip.id} (${activeClip.title})`}
          userMessage={
            activeClip.lastRenderDiagnostic?.userMessage ||
            activeClip.lastRenderError ||
            'Video clip rendering encountered an encoding error. Your concurrency slot has been released.'
          }
          remediation={
            activeClip.lastRenderDiagnostic?.remediation ||
            'Verify the clip duration is ≤ 120 seconds and click Retry Render.'
          }
          diagnostic={activeClip.lastRenderDiagnostic}
          onRetry={() => handleTriggerRender(activeClip)}
        />
      )}

      {clips.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-12 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-800">
            No video clip candidates discovered yet.
          </p>
          <button
            type="button"
            onClick={() => onDiscoverClips(!geminiConfigured)}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Run Clip Discovery Engine
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 4 Cols: Ranked Candidate Clips List */}
          <div className="lg:col-span-4 space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Ranked by 10-Criteria Editorial Score</span>
              <button
                type="button"
                onClick={() =>
                  setBatchSelectedClipIds(
                    batchSelectedClipIds.length === clips.length
                      ? []
                      : clips.map((c) => c.id)
                  )
                }
                className="font-mono text-blue-600 hover:underline"
              >
                {batchSelectedClipIds.length === clips.length
                  ? 'Deselect All'
                  : 'Select All'}
              </button>
            </div>

            {clips.map((clip, idx) => {
              const isSelected = activeClip?.id === clip.id;
              const isBatchChecked = batchSelectedClipIds.includes(clip.id);
              const statusBadgeColor =
                clip.renderStatus === 'ready_for_review' ||
                clip.renderStatus === 'approved' ||
                clip.renderStatus === 'completed'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30'
                  : clip.renderStatus === 'processing'
                    ? 'bg-blue-500/20 text-blue-300 border-blue-400/30'
                    : clip.renderStatus === 'queued'
                      ? 'bg-amber-500/20 text-amber-300 border-amber-400/30'
                      : clip.renderStatus === 'failed'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-400/30'
                        : 'bg-slate-200 text-slate-700';

              return (
                <div
                  key={clip.id}
                  onClick={() => setSelectedClipId(clip.id)}
                  className={`w-full text-left p-4 rounded-lg border transition-colors space-y-2 cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div
                    className={`flex items-center justify-between text-xs ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isBatchChecked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleBatchClipSelection(clip.id)}
                        aria-label={`Select ${clip.id} for batch action`}
                        className="cursor-pointer"
                      />
                      <span className="font-mono font-bold">
                        #{idx + 1} · {clip.id} · Score {clip.editorialScores.overallScore}/100
                      </span>
                    </div>
                    <span
                      className={`font-mono uppercase text-[10px] px-2 py-0.5 rounded border ${
                        isSelected
                          ? statusBadgeColor
                          : clip.renderStatus === 'ready_for_review' ||
                              clip.renderStatus === 'approved'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : clip.renderStatus === 'processing'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : clip.renderStatus === 'queued'
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : clip.renderStatus === 'failed'
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      {clip.renderStatus.replace(/_/g, ' ')}
                    </span>
                  </div>

                  <p className="text-sm font-semibold line-clamp-2">
                    {clip.title}
                  </p>

                  <div
                    className={`flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    <span>
                      {formatTimestamp(clip.start)} – {formatTimestamp(clip.end)} ({clip.duration}s)
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{clip.renderConfig?.layoutMode || 'smart-crop'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{clip.recommendedPlatform}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right 8 Cols: Cut Sheet Inspector, Vertical Composition Studio, Players & FFmpeg Controls */}
          {activeClip && (
            <div className="lg:col-span-8 space-y-6">
              {/* Top Card: Dual Video Players (Source Preview vs Rendered 9:16 MP4 + Zoom) */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-800 whitespace-nowrap">
                        {activeClip.id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap">{recommendedPlatform}</span>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap font-mono text-emerald-700 font-semibold">
                        Duration: {Math.max(1, Math.round((endSec - startSec) * 10) / 10)}s / 120s Max
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap">
                        Status:{' '}
                        <strong className="uppercase text-slate-900">
                          {renderingId === activeClip.id
                            ? 'PROCESSING FFMPEG...'
                            : activeClip.renderStatus.replace(/_/g, ' ')}
                        </strong>
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 mt-1">
                      {activeClip.title}
                    </h3>
                  </div>

                  <div className="relative flex flex-wrap items-center gap-2 shrink-0">
                    {/* Keyboard Shortcut Help Tooltip Trigger */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowShortcutsTooltip((prev) => !prev)}
                        aria-expanded={showShortcutsTooltip}
                        aria-label="Keyboard shortcuts help"
                        title="Player Keyboard Shortcuts (?)"
                        className={`inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold rounded-md border transition-colors ${
                          showShortcutsTooltip
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        <Keyboard className="w-3.5 h-3.5" />
                        <span>? Shortcuts</span>
                      </button>

                      {showShortcutsTooltip && (
                        <div
                          role="dialog"
                          aria-label="Video Player Keyboard Shortcuts"
                          className="absolute right-0 mt-2 w-80 bg-slate-900 text-white rounded-lg shadow-xl border border-slate-700 p-4 z-30 space-y-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between border-b border-slate-700 pb-2">
                            <span className="font-bold flex items-center gap-1.5 text-slate-100">
                              <HelpCircle className="w-3.5 h-3.5 text-blue-400" />
                              Player Keyboard Shortcuts
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowShortcutsTooltip(false)}
                              className="text-slate-400 hover:text-white text-[11px] font-mono"
                            >
                              ESC
                            </button>
                          </div>
                          <div className="space-y-1.5 text-[11px]">
                            {[
                              { keys: 'Space / K', action: 'Play / Pause active player' },
                              { keys: 'J / L', action: 'Rewind / Fast-Forward 5 seconds' },
                              { keys: ', / .', action: 'Frame Step Back / Forward (1/24s)' },
                              { keys: '[ / ]', action: 'Nudge Clip Start / End by 0.5s' },
                              { keys: 'M', action: 'Toggle Mute / Unmute audio' },
                              { keys: 'F', action: 'Toggle Fullscreen video player' },
                              { keys: '?', action: 'Show / Hide this shortcuts guide' },
                            ].map((item) => (
                              <div
                                key={item.keys}
                                className="flex items-center justify-between gap-2 py-0.5"
                              >
                                <span className="text-slate-300">{item.action}</span>
                                <kbd className="px-1.5 py-0.5 font-mono text-[10px] font-semibold bg-slate-800 text-blue-300 border border-slate-700 rounded shrink-0">
                                  {item.keys}
                                </kbd>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {(activeClip.renderStatus === 'processing' ||
                      activeClip.renderStatus === 'queued') && (
                      <button
                        type="button"
                        onClick={() => handleCancelRender(activeClip.id)}
                        className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-md hover:bg-rose-100"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Cancel Render
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busy || renderingId === activeClip.id}
                      onClick={() => handleTriggerRender(activeClip)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Film className="w-3.5 h-3.5" />
                      {renderingId === activeClip.id
                        ? 'Rendering via FFmpeg...'
                        : activeClip.renderStatus === 'failed' ||
                            activeClip.renderStatus === 'cancelled'
                          ? 'Retry Render (FFmpeg)'
                          : activeClip.outputVideoUrl
                            ? 'Rerender Clip (FFmpeg)'
                            : 'Render Clip (FFmpeg)'}
                    </button>

                    {activeClip.outputVideoUrl && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleSaveBoundariesAndConfig('approved')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Approve Clip
                      </button>
                    )}
                  </div>
                </div>

                {/* Video Preview Grid (Source vs Rendered Composition + Zoom) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">
                        1. Source Master Interval Preview
                      </span>
                      <button
                        type="button"
                        onClick={handlePreviewSourceInterval}
                        className="inline-flex items-center gap-1 text-blue-600 font-semibold hover:underline"
                      >
                        <Play className="w-3 h-3" />
                        Play {formatTimestamp(startSec)}–{formatTimestamp(endSec)}
                      </button>
                    </div>
                    {source?.publicMediaUrl || localPreviewUrl ? (
                      <div className="rounded-md overflow-hidden bg-slate-950 border border-slate-800 h-64 flex items-center justify-center">
                        <video
                          key={`${source?.id || 'local'}-${localPreviewUrl || source?.publicMediaUrl}`}
                          ref={sourceVideoRef}
                          src={localPreviewUrl || source?.publicMediaUrl}
                          controls
                          playsInline
                          preload="metadata"
                          className="w-full h-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="h-64 bg-slate-100 border border-slate-200 rounded-md flex items-center justify-center p-4 text-center text-xs text-slate-500">
                        No source video attached. Load studio sample keynote in Source Material tab.
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-700">
                        2. Rendered Output ({aspectRatio} · {layoutMode})
                      </span>
                      <div className="flex items-center gap-2">
                        {/* Preview Zoom Controls */}
                        <div className="flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                          <button
                            type="button"
                            onClick={() =>
                              setOutputPreviewZoom((z) =>
                                Math.max(0.5, Math.round((z - 0.25) * 100) / 100)
                              )
                            }
                            title="Zoom Out Rendered Preview"
                            className="p-0.5 text-slate-600 hover:text-slate-900"
                          >
                            <ZoomOut className="w-3 h-3" />
                          </button>
                          <span className="font-mono text-[10px] text-slate-700">
                            {Math.round(outputPreviewZoom * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setOutputPreviewZoom((z) =>
                                Math.min(2.25, Math.round((z + 0.25) * 100) / 100)
                              )
                            }
                            title="Zoom In Rendered Preview"
                            className="p-0.5 text-slate-600 hover:text-slate-900"
                          >
                            <ZoomIn className="w-3 h-3" />
                          </button>
                          {outputPreviewZoom !== 1 && (
                            <button
                              type="button"
                              onClick={() => setOutputPreviewZoom(1)}
                              className="text-[10px] font-mono text-blue-600 hover:underline ml-0.5"
                            >
                              Fit
                            </button>
                          )}
                        </div>

                        {activeClip.outputVideoUrl && (
                          <div className="flex items-center gap-2">
                            <a
                              href={activeClip.outputVideoUrl}
                              download={`${activeClip.id}.mp4`}
                              className="inline-flex items-center gap-1 text-blue-600 font-semibold hover:underline"
                            >
                              <Download className="w-3 h-3" /> .MP4
                            </a>
                            {activeClip.outputSrtUrl && (
                              <a
                                href={activeClip.outputSrtUrl}
                                download={`${activeClip.id}.srt`}
                                className="inline-flex items-center gap-1 text-slate-700 font-semibold hover:underline"
                              >
                                <Download className="w-3 h-3" /> .SRT
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {activeClip.outputVideoUrl ? (
                      <div className="rounded-md overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center h-64">
                        <video
                          key={activeClip.outputVideoUrl}
                          ref={renderedVideoRef}
                          src={activeClip.outputVideoUrl}
                          controls
                          style={{
                            transform: `scale(${outputPreviewZoom})`,
                            transformOrigin: 'center center',
                          }}
                          className="h-full max-w-full object-contain transition-transform duration-150"
                        />
                      </div>
                    ) : (
                      <div className="h-64 bg-slate-50 border border-dashed border-slate-300 rounded-md flex flex-col items-center justify-center p-6 text-center space-y-2">
                        <Video className="w-6 h-6 text-slate-400" />
                        <p className="text-xs font-semibold text-slate-700">
                          {activeClip.renderStatus === 'queued'
                            ? 'Queued — Waiting for Render Slot'
                            : activeClip.renderStatus === 'processing'
                              ? 'Encoding via Staged FFmpeg Pipeline...'
                              : 'Not Rendered Yet'}
                        </p>
                        <p className="text-xs text-slate-500">
                          Choose a Vertical Composition Mode below (e.g., Smart Crop, Speaker Focus, Split-Screen) and click &ldquo;Render Clip (FFmpeg)&rdquo;.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Smart Short-Video Production Suite (All 4 Smart Tools: Word Highlights, Hooks, Audio Norm, Multi-Segment Stitching) */}
                <div className="p-4 bg-slate-900 text-white rounded-lg border border-slate-800 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" />
                        Smart Short-Video Production Suite (FFmpeg AI Enhancements)
                      </h4>
                      <p className="text-xs text-slate-300 mt-0.5">
                        Transforms raw clips into broadcast-ready vertical shorts with dynamic keyword callouts, opening hooks, -16 LUFS audio mastering, and multi-segment highlight stitching.
                      </p>
                    </div>
                    {activeClip.renderConfig?.stitchedSegments &&
                      activeClip.renderConfig.stitchedSegments.length >= 2 && (
                        <span className="px-2.5 py-1 text-[11px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded">
                          Stitched Multi-Segment Short ({activeClip.renderConfig.stitchedSegments.length} cuts)
                        </span>
                      )}
                  </div>

                  {/* 4 Smart Feature Toggles */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
                    <label className="flex items-start gap-2.5 p-2.5 rounded-md bg-slate-800/90 border border-slate-700 cursor-pointer hover:border-blue-500/60">
                      <input
                        type="checkbox"
                        checked={enableWordHighlighting}
                        onChange={(e) => setEnableWordHighlighting(e.target.checked)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div>
                        <span className="font-semibold text-white block">
                          Active Word Highlights
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Emphasizes high-impact spoken keywords in gold above subtitles.
                        </span>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-2.5 rounded-md bg-slate-800/90 border border-slate-700 cursor-pointer hover:border-blue-500/60">
                      <input
                        type="checkbox"
                        checked={showHookBanner}
                        onChange={(e) => setShowHookBanner(e.target.checked)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div>
                        <span className="font-semibold text-white block">
                          AI Hook Intro Card (0–5s)
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Burns a punchy KEY INSIGHT headline card on opening frames.
                        </span>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-2.5 rounded-md bg-slate-800/90 border border-slate-700 cursor-pointer hover:border-blue-500/60">
                      <input
                        type="checkbox"
                        checked={enableAudioNormalization}
                        onChange={(e) => setEnableAudioNormalization(e.target.checked)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div>
                        <span className="font-semibold text-white flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-emerald-400" />
                          Audio Norm (-16 LUFS)
                        </span>
                        <span className="text-[11px] text-slate-400">
                          EBU R128 broadcast loudness mastering across speakers.
                        </span>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-2.5 rounded-md bg-slate-800/90 border border-slate-700 cursor-pointer hover:border-blue-500/60">
                      <input
                        type="checkbox"
                        checked={enableSilenceTrimming}
                        onChange={(e) => setEnableSilenceTrimming(e.target.checked)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div>
                        <span className="font-semibold text-white flex items-center gap-1">
                          <Scissors className="w-3 h-3 text-amber-400" />
                          Dead-Air Silence Trim
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Removes leading dead-air pauses (-42dB threshold) for tight pacing.
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* Multi-Segment Highlight Stitcher */}
                  {enrichedTranscript.length >= 2 && (
                    <div className="pt-2 border-t border-slate-800 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 text-blue-400" />
                          Multi-Segment Highlight Stitcher — Select 2+ Moments to Combine into One Cohesive Short:
                        </span>
                        <button
                          type="button"
                          disabled={busy || stitchSegmentIds.length < 2}
                          onClick={handleCreateSmartStitchedClip}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
                        >
                          <Scissors className="w-3.5 h-3.5" />
                          Create Smart Stitched Short ({stitchSegmentIds.length} segments)
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-1">
                        {enrichedTranscript.slice(0, 12).map((seg) => {
                          const checked = stitchSegmentIds.includes(seg.id);
                          return (
                            <button
                              key={seg.id}
                              type="button"
                              onClick={() => toggleStitchSegment(seg.id)}
                              className={`px-2.5 py-1 rounded text-[11px] font-mono border text-left transition-colors ${
                                checked
                                  ? 'bg-blue-600 text-white border-blue-400 font-semibold'
                                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                              }`}
                            >
                              {checked ? '✓ ' : '+ '}
                              {seg.id} ({formatTimestamp(seg.start)}–{formatTimestamp(seg.end)}):{' '}
                              {seg.text.slice(0, 34)}...
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Priority 7: Context-Aware AI Content Director Recommendations */}
                {aiRecommendations && (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                        AI Content Director — Editorial Context & Standalone Assessment
                      </span>
                      <span
                        className={`font-mono text-[11px] px-2 py-0.5 rounded border font-semibold ${
                          aiRecommendations.worksIndependently
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border-amber-200'
                        }`}
                      >
                        {aiRecommendations.worksIndependently
                          ? '✓ Works Standalone'
                          : 'Needs Introductory Hook Context'}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-700">
                      <div>
                        <span className="font-semibold text-slate-900 block">
                          Why Selected:
                        </span>
                        <p>{aiRecommendations.whySelected}</p>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-900 block">
                          What the Audience Learns:
                        </span>
                        <p>{aiRecommendations.whatAudienceLearns}</p>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-900 block">
                          Intended Audience & Platform:
                        </span>
                        <p>
                          {aiRecommendations.intendedAudience} · Best for{' '}
                          <strong>{aiRecommendations.recommendedPlatform}</strong>
                        </p>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-900 block">
                          Suggested Opening Hook:
                        </span>
                        <p className="italic">&ldquo;{aiRecommendations.compellingOpeningReason}&rdquo;</p>
                      </div>
                    </div>
                    {aiRecommendations.missingContextNote && (
                      <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                        <strong>Context Note:</strong> {aiRecommendations.missingContextNote}
                      </p>
                    )}
                  </div>
                )}

                {/* Boundary Validation Diagnostics */}
                <div
                  className={`p-4 rounded-md border text-xs space-y-2 ${
                    activeClip.boundaryValidation.status === 'invalid'
                      ? 'bg-red-50 border-red-200 text-red-900'
                      : activeClip.boundaryValidation.status === 'needs_review'
                        ? 'bg-amber-50 border-amber-200 text-amber-900'
                        : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold">
                      Boundary Validation Status:{' '}
                      {activeClip.boundaryValidation.status.toUpperCase()}
                    </span>
                    <span className="font-mono">
                      Segments: {activeClip.sourceSegmentIds.join(', ')}
                    </span>
                  </div>

                  {activeClip.boundaryValidation.warnings.length > 0 ? (
                    <ul className="list-disc pl-4 space-y-0.5">
                      {activeClip.boundaryValidation.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-slate-600">
                      Start and end timestamps align cleanly with verified sentence boundaries and comply with the 120s Short-Form limit.
                    </p>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/70">
                    <div>
                      <span className="font-semibold text-slate-600">
                        Exact Opening Line:
                      </span>
                      <p className="italic mt-0.5 line-clamp-2">
                        &ldquo;{activeClip.openingText}&rdquo;
                      </p>
                    </div>
                    <div>
                      <span className="font-semibold text-slate-600">
                        Exact Closing Line:
                      </span>
                      <p className="italic mt-0.5 line-clamp-2">
                        &ldquo;{activeClip.closingText}&rdquo;
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Priority 3: Intelligent Vertical Video Composition & Manual Crop Studio */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-blue-600" />
                      Intelligent Vertical Video Composition & Manual Reframe Studio
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Genuine FFmpeg filtergraph composition — Smart Crop, Speaker Focus, Dynamic Switching, Split-Screen, PiP, or Manual X/Y/Zoom.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAutoDetectSmartFraming}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Auto-Detect Smart Framing
                    </button>
                    <button
                      type="button"
                      onClick={handleResetFraming}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset Framing
                    </button>
                  </div>
                </div>

                {/* 7 Composition Mode Selector Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                  {COMPOSITION_MODES.map((m) => {
                    const active = layoutMode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setLayoutMode(m.id)}
                        className={`p-3 rounded-md border text-left transition-colors space-y-1 ${
                          active
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50/70 text-slate-800 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 text-xs font-bold">
                          <span className="truncate">{m.label}</span>
                          <span
                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${
                              active
                                ? 'bg-blue-500/30 text-blue-200'
                                : 'bg-white text-slate-600 border border-slate-200'
                            }`}
                          >
                            {m.badge}
                          </span>
                        </div>
                        <p
                          className={`text-[11px] leading-snug ${
                            active ? 'text-slate-300' : 'text-slate-500'
                          }`}
                        >
                          {m.description}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {/* Manual Crop & Reframe Sliders (X, Y, Zoom) + Crop Validation Report */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pt-2 border-t border-slate-100 items-center">
                  <div className="lg:col-span-8 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                      <div>
                        <div className="flex justify-between font-semibold text-slate-700 mb-1">
                          <label htmlFor="crop-x-slider">Horizontal Pan (X)</label>
                          <span className="font-mono">{manualCrop.horizontalOffset}%</span>
                        </div>
                        <input
                          id="crop-x-slider"
                          type="range"
                          min={-100}
                          max={100}
                          step={5}
                          value={manualCrop.horizontalOffset}
                          onChange={(e) =>
                            setManualCrop((prev) => ({
                              ...prev,
                              horizontalOffset: Number(e.target.value),
                            }))
                          }
                          className="w-full accent-blue-600 cursor-pointer"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between font-semibold text-slate-700 mb-1">
                          <label htmlFor="crop-y-slider">Vertical Tilt (Y)</label>
                          <span className="font-mono">{manualCrop.verticalOffset}%</span>
                        </div>
                        <input
                          id="crop-y-slider"
                          type="range"
                          min={-100}
                          max={100}
                          step={5}
                          value={manualCrop.verticalOffset}
                          onChange={(e) =>
                            setManualCrop((prev) => ({
                              ...prev,
                              verticalOffset: Number(e.target.value),
                            }))
                          }
                          className="w-full accent-blue-600 cursor-pointer"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between font-semibold text-slate-700 mb-1">
                          <label htmlFor="crop-zoom-slider">Subject Zoom</label>
                          <span className="font-mono">{manualCrop.zoom.toFixed(2)}x</span>
                        </div>
                        <input
                          id="crop-zoom-slider"
                          type="range"
                          min={1.0}
                          max={2.4}
                          step={0.05}
                          value={manualCrop.zoom}
                          onChange={(e) =>
                            setManualCrop((prev) => ({
                              ...prev,
                              zoom: Number(e.target.value),
                            }))
                          }
                          className="w-full accent-blue-600 cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleSaveBoundariesAndConfig()}
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded hover:bg-slate-800"
                      >
                        Apply Framing to Current Clip ({activeClip.id})
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleApplyFramingToSelectedClips}
                        className="px-3 py-1.5 text-xs font-semibold bg-white text-slate-800 border border-slate-300 rounded hover:bg-slate-50"
                      >
                        Apply Framing to{' '}
                        {batchSelectedClipIds.length > 0
                          ? `Selected Clips (${batchSelectedClipIds.length})`
                          : `All Clips (${clips.length})`}
                      </button>
                    </div>
                  </div>

                  {/* Crop Validation Status Card */}
                  <div
                    className={`lg:col-span-4 p-3.5 rounded-md border text-xs space-y-1.5 ${
                      cropValidation.valid
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                        : 'bg-amber-50 border-amber-200 text-amber-950'
                    }`}
                  >
                    <div className="flex items-center justify-between font-bold">
                      <span>Crop & Safe-Zone Check</span>
                      <span className="font-mono uppercase text-[10px] px-1.5 py-0.5 rounded bg-white/80 border border-current">
                        {cropValidation.valid ? 'PASSED' : 'REVIEW'}
                      </span>
                    </div>
                    <p className="text-[11px]">
                      Subject Visible: <strong>{cropValidation.importantContentVisible ? 'Yes' : 'Edge Offset'}</strong> ·
                      Safe Margins: <strong>{cropValidation.captionsInSafeArea ? 'Clear' : 'Tight'}</strong> ·
                      Aspect Ratio: <strong>{cropValidation.aspectRatioPreserved ? 'Verified' : 'Adjusted'}</strong>
                    </p>
                    {cropValidation.warnings.length > 0 && (
                      <p className="text-[11px] font-medium text-amber-900">
                        {cropValidation.warnings[0]}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom Card: Editable Boundaries, Short-Form Duration Presets, Caption Script Mode & Layout */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900">
                    Editable Cut Sheet, Short-Form Trim (≤120s) & Romanised Subtitle Burn-In
                  </h3>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500">Quick Duration Preset:</span>
                    {[30, 45, 60, 90, 120].map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        onClick={() => applyDurationPreset(sec)}
                        className="px-2 py-0.5 font-mono text-[11px] rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-800"
                      >
                        {sec}s
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
                  <div>
                    <label
                      htmlFor="clip-start-input"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Start (seconds)
                    </label>
                    <input
                      id="clip-start-input"
                      type="number"
                      min={0}
                      max={source?.mediaDurationSeconds || 90}
                      step={1}
                      value={startSec}
                      onChange={(e) => {
                        const nextS = Math.max(0, Number(e.target.value));
                        setStartSec(nextS);
                        if (endSec - nextS > SHORT_FORM_MAX_DURATION_SEC) {
                          setEndSec(nextS + SHORT_FORM_MAX_DURATION_SEC);
                        }
                      }}
                      className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="clip-end-input"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      End (seconds)
                    </label>
                    <input
                      id="clip-end-input"
                      type="number"
                      min={1}
                      max={source?.mediaDurationSeconds || 90}
                      step={1}
                      value={endSec}
                      onChange={(e) => {
                        const rawE = Number(e.target.value);
                        const cappedE = Math.min(
                          rawE,
                          startSec + SHORT_FORM_MAX_DURATION_SEC
                        );
                        setEndSec(cappedE);
                      }}
                      className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <span className="block text-xs font-semibold text-slate-700 mb-1">
                      Clip Duration (≤120s)
                    </span>
                    <div className="px-3 py-1.5 text-sm font-mono tabular-nums bg-emerald-50 border border-emerald-200 rounded-md text-emerald-900 font-bold">
                      {Math.max(0, Math.round((endSec - startSec) * 10) / 10)}s
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="clip-platform-select"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Target Short Platform
                    </label>
                    <select
                      id="clip-platform-select"
                      value={recommendedPlatform}
                      onChange={(e) => setRecommendedPlatform(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
                    >
                      <option value="YouTube Shorts">YouTube Shorts (≤120s)</option>
                      <option value="Instagram Reels">Instagram Reels (≤120s)</option>
                      <option value="TikTok">TikTok (≤120s)</option>
                      <option value="LinkedIn">LinkedIn Video (≤120s)</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="clip-aspect-select"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Aspect Ratio
                    </label>
                    <select
                      id="clip-aspect-select"
                      value={aspectRatio}
                      onChange={(e) => setAspectRatio(e.target.value as any)}
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
                    >
                      <option value="9:16">9:16 Vertical Portrait</option>
                      <option value="1:1">1:1 Square Feed</option>
                      <option value="16:9">16:9 Landscape</option>
                      <option value="original">Original Aspect Ratio</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label
                      htmlFor="clip-caption-script-mode"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Subtitle / Caption Script Mode (Priority 5)
                    </label>
                    <select
                      id="clip-caption-script-mode"
                      value={captionScriptMode}
                      onChange={(e) =>
                        setCaptionScriptMode(e.target.value as CaptionScriptMode)
                      }
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white font-medium"
                    >
                      <option value="romanised">
                        Romanised (Hinglish / Latin Script)
                      </option>
                      <option value="original">
                        Original Spoken Script (Devanagari / Native)
                      </option>
                      <option value="both">
                        Bilingual (Original + Romanised)
                      </option>
                      <option value="translation">
                        Translated Captions (English)
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="clip-caption-pos"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Caption Safe-Zone Position
                    </label>
                    <select
                      id="clip-caption-pos"
                      value={captionPos}
                      onChange={(e) => setCaptionPos(e.target.value as any)}
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
                    >
                      <option value="bottom">Bottom Safe Margin</option>
                      <option value="center">Center Frame</option>
                      <option value="top">Upper Third</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="clip-max-words"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Max Words Per Caption Segment
                    </label>
                    <input
                      id="clip-max-words"
                      type="number"
                      min={4}
                      max={16}
                      value={maxWordsPerSegment}
                      onChange={(e) =>
                        setMaxWordsPerSegment(Number(e.target.value))
                      }
                      className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="clip-onscreen-hook"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      On-Screen Title / Hook Banner Text
                    </label>
                    <input
                      id="clip-onscreen-hook"
                      type="text"
                      value={onScreenTitle}
                      onChange={(e) => setOnScreenTitle(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
                    />
                  </div>
                  <div className="flex items-end gap-4 pb-1.5 text-xs">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={burnInCaptions}
                        onChange={(e) => setBurnInCaptions(e.target.checked)}
                      />
                      Burn-In Captions
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={showLogo}
                        onChange={(e) => setShowLogo(e.target.checked)}
                      />
                      Brand Logo Overlay
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={showHookBanner}
                        onChange={(e) => setShowHookBanner(e.target.checked)}
                      />
                      Opening Title Banner
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="clip-social-caption"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Companion Social Post Caption
                    </label>
                    <textarea
                      id="clip-social-caption"
                      rows={4}
                      value={captionText}
                      onChange={(e) => setCaptionText(e.target.value)}
                      className="w-full p-2.5 text-xs border border-slate-300 rounded-md"
                    />
                  </div>

                  <div>
                    <span className="block text-xs font-semibold text-slate-700 mb-1">
                      Synchronized SRT Subtitle Preview ({liveSrtPreview?.cueCount || 0} cues · {captionScriptMode.toUpperCase()})
                    </span>
                    <pre className="p-2.5 bg-slate-900 text-slate-100 rounded-md text-xs font-mono h-24 overflow-y-auto whitespace-pre-wrap">
                      {liveSrtPreview?.srtContent || 'No overlapping cues in interval.'}
                    </pre>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleSaveBoundariesAndConfig()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save Boundary & Layout Settings
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleSimulateFailureRecovery(activeClip.id)}
                      className="px-3 py-2 text-xs font-mono text-amber-800 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100"
                    >
                      Test Failure & Slot Recovery
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleSaveBoundariesAndConfig('rejected')}
                      className="px-3.5 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100"
                    >
                      Reject Clip
                    </button>
                    <button
                      type="button"
                      disabled={busy || Boolean(renderingId)}
                      onClick={() => handleTriggerRender(activeClip)}
                      className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800"
                    >
                      Save & Render via FFmpeg
                    </button>
                  </div>
                </div>
              </div>

              {/* Render Jobs History Queue */}
              <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-800">
                    FFmpeg Render Job Queue & History ({renderJobs.length})
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500">
                    Staged Pipeline: Verify → Fast Extract → Aspect/Composition → Captions → H.264 Validate
                  </span>
                </div>
                {renderJobs.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No FFmpeg render jobs executed yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 text-xs">
                    {renderJobs.slice(0, 8).map((job) => (
                      <div
                        key={job.id}
                        className="py-2.5 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-slate-900">
                              {job.id} ({job.clipId})
                            </span>
                            <span className="text-slate-400">·</span>
                            <span>
                              {job.config.aspectRatio} {job.config.layoutMode}
                            </span>
                            {job.stageProgress && (
                              <>
                                <span className="text-slate-400">·</span>
                                <span className="font-mono text-[11px] text-blue-700">
                                  {job.stageProgress}
                                </span>
                              </>
                            )}
                            <span className="text-slate-400">·</span>
                            <span
                              className={`uppercase font-mono text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                                job.status === 'ready_for_review' ||
                                job.status === 'completed'
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : job.status === 'processing'
                                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                                    : job.status === 'queued'
                                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                                      : 'bg-rose-50 text-rose-700 border-rose-200'
                              }`}
                            >
                              {job.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          {job.errorDetails && (
                            <p className="text-amber-800 mt-0.5">
                              {job.diagnostic?.userMessage || job.errorDetails}
                            </p>
                          )}
                        </div>
                        {job.publicVideoUrl && (
                          <a
                            href={job.publicVideoUrl}
                            download
                            className="text-blue-600 font-semibold hover:underline shrink-0"
                          >
                            Download MP4 ({job.durationSeconds}s)
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};


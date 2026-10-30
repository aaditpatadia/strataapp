import React, { useEffect, useRef, useState } from 'react';
import { formatTimestamp } from '../lib/coreLogic';
import type { DiagnosticRecord, SourceMaterial } from '../types/domain';

interface PersistentMediaInspectorProps {
  source: SourceMaterial | null;
  localPreviewUrl?: string | null;
  localPreviewName?: string | null;
  seekRequestSec?: number | null;
  onTimeUpdateSec?: (currentTimeSec: number) => void;
  intervalStartSec?: number;
  intervalEndSec?: number;
  compact?: boolean;
  title?: string;
  onOpenSection?: (
    tab:
      | 'overview'
      | 'source'
      | 'transcript'
      | 'intelligence'
      | 'assets'
      | 'clips'
      | 'calendar'
      | 'exports'
      | 'integrations'
      | 'settings'
  ) => void;
}

export const PersistentMediaInspector: React.FC<PersistentMediaInspectorProps> = ({
  source,
  localPreviewUrl,
  localPreviewName,
  seekRequestSec,
  onTimeUpdateSec,
  intervalStartSec,
  intervalEndSec,
  compact = false,
  title = 'Persistent Source Media Inspector',
  onOpenSection,
}) => {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(source?.mediaDurationSeconds || 0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [loopInterval, setLoopInterval] = useState(false);

  // Visual Preview Zoom & Pan (presentation-only, never alters source media or clip boundaries)
  const [previewZoomPct, setPreviewZoomPct] = useState<number>(100);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; origX: number; origY: number }>({
    x: 0,
    y: 0,
    origX: 0,
    origY: 0,
  });

  const effectiveMediaUrl = localPreviewUrl || source?.publicMediaUrl || null;
  const effectiveFileName =
    localPreviewName || source?.fileName || 'No source media attached';
  const isLocalBlob = Boolean(
    localPreviewUrl && (!source?.publicMediaUrl || localPreviewUrl.startsWith('blob:'))
  );
  const hasVideo = source ? source.hasVideoStream : Boolean(localPreviewUrl);
  const hasAudio = source ? source.hasAudioStream : true;
  const fps = source?.frameRate && source.frameRate > 0 ? source.frameRate : 30;
  const frameStepSec = 1 / fps;

  useEffect(() => {
    if (source?.mediaDurationSeconds && source.mediaDurationSeconds > 0) {
      setDuration(source.mediaDurationSeconds);
    }
  }, [source?.mediaDurationSeconds]);

  useEffect(() => {
    if (
      seekRequestSec !== undefined &&
      seekRequestSec !== null &&
      mediaRef.current &&
      Number.isFinite(seekRequestSec)
    ) {
      mediaRef.current.currentTime = Math.max(0, seekRequestSec);
      setCurrentTime(Math.max(0, seekRequestSec));
      mediaRef.current.play().catch(() => {
        // Autoplay may be blocked by browser policy
      });
    }
  }, [seekRequestSec]);

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      if (
        intervalStartSec !== undefined &&
        intervalEndSec !== undefined &&
        (el.currentTime < intervalStartSec || el.currentTime >= intervalEndSec)
      ) {
        el.currentTime = intervalStartSec;
      }
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const stepFrame = (direction: -1 | 1) => {
    const el = mediaRef.current;
    if (!el) return;
    el.pause();
    const totalDur = Math.max(1, duration || source?.mediaDurationSeconds || 1);
    const next = Math.max(0, Math.min(totalDur, el.currentTime + direction * frameStepSec));
    el.currentTime = next;
    setCurrentTime(next);
    onTimeUpdateSec?.(next);
  };

  const handleSeekBarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(e.target.value);
    setCurrentTime(nextTime);
    if (mediaRef.current) {
      mediaRef.current.currentTime = nextTime;
    }
    onTimeUpdateSec?.(nextTime);
  };

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = rate;
    }
  };

  const handleVolumeChange = (nextVol: number) => {
    const clamped = Math.max(0, Math.min(1, nextVol));
    setVolume(clamped);
    setIsMuted(clamped === 0);
    if (mediaRef.current) {
      mediaRef.current.volume = clamped;
      mediaRef.current.muted = clamped === 0;
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (mediaRef.current) {
      mediaRef.current.muted = nextMuted;
    }
  };

  const handleFullscreen = () => {
    const container = viewportRef.current || mediaRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (container.requestFullscreen) {
      container.requestFullscreen().catch(() => {});
    }
  };

  const handleZoomChange = (nextZoom: number) => {
    const clamped = Math.max(50, Math.min(250, nextZoom));
    setPreviewZoomPct(clamped);
    if (clamped <= 100) {
      setPanOffset({ x: 0, y: 0 });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (mediaRef.current) {
        const next = Math.max(0, mediaRef.current.currentTime - 5);
        mediaRef.current.currentTime = next;
        setCurrentTime(next);
      }
    } else if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (mediaRef.current) {
        const totalDur = Math.max(1, duration || source?.mediaDurationSeconds || 1);
        const next = Math.min(totalDur, mediaRef.current.currentTime + 5);
        mediaRef.current.currentTime = next;
        setCurrentTime(next);
      }
    } else if (e.key === ',') {
      e.preventDefault();
      stepFrame(-1);
    } else if (e.key === '.') {
      e.preventDefault();
      stepFrame(1);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMute();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      handleFullscreen();
    }
  };

  const playIntervalSegment = () => {
    const el = mediaRef.current;
    if (!el || intervalStartSec === undefined) return;
    el.currentTime = Math.max(0, intervalStartSec);
    setCurrentTime(Math.max(0, intervalStartSec));
    el.play().catch(() => {});
  };

  if (!effectiveMediaUrl && !source) {
    return (
      <div className="bg-white border border-slate-200 rounded-md p-4 transition-all">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
              {title}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Upload a video/audio file or load the sample keynote in 02. Source Media to enable instant playback across all tabs.
            </p>
          </div>
          {onOpenSection && (
            <button
              onClick={() => onOpenSection('source')}
              className="text-xs font-semibold px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800 transition-colors"
            >
              Upload Source Media
            </button>
          )}
        </div>
      </div>
    );
  }

  const totalDur = Math.max(1, duration || source?.mediaDurationSeconds || 1);

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={title}
      className="bg-white border border-slate-200 rounded-md overflow-hidden shadow-xs focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
    >
      {/* Header Metadata Bar */}
      <div className="px-4 py-2.5 bg-slate-900 text-white flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
          <span className="text-xs font-bold tracking-wide truncate">
            {effectiveFileName}
          </span>
          <span
            className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold ${
              isLocalBlob
                ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30'
                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
            }`}
          >
            {isLocalBlob ? 'Browser Local Preview' : 'Persisted Server Media'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-300">
          {source && source.width > 0 && (
            <span className="bg-slate-800 px-2 py-0.5 rounded">
              {source.width}×{source.height}
            </span>
          )}
          <span className="bg-slate-800 px-2 py-0.5 rounded">{fps} fps</span>
          <span className="bg-slate-800 px-2 py-0.5 rounded">
            Audio: {hasAudio ? (isMuted ? 'Muted' : 'Active') : 'None'}
          </span>
          <span className="bg-slate-800 px-2 py-0.5 rounded text-emerald-300">
            {formatTimestamp(currentTime)} / {formatTimestamp(totalDur)}
          </span>
        </div>
      </div>

      {/* Media Viewport + Controls */}
      <div
        className={`grid grid-cols-1 ${
          compact ? 'lg:grid-cols-12' : 'lg:grid-cols-12'
        } gap-4 p-4 items-center bg-slate-950`}
      >
        <div className={compact ? 'lg:col-span-5' : 'lg:col-span-7'}>
          {effectiveMediaUrl && hasVideo ? (
            <div
              ref={viewportRef}
              onMouseDown={(e) => {
                if (previewZoomPct <= 100) return;
                setIsPanning(true);
                panStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  origX: panOffset.x,
                  origY: panOffset.y,
                };
              }}
              onMouseMove={(e) => {
                if (!isPanning || previewZoomPct <= 100) return;
                const dx = e.clientX - panStartRef.current.x;
                const dy = e.clientY - panStartRef.current.y;
                setPanOffset({
                  x: Math.max(-240, Math.min(240, panStartRef.current.origX + dx)),
                  y: Math.max(-180, Math.min(180, panStartRef.current.origY + dy)),
                });
              }}
              onMouseUp={() => setIsPanning(false)}
              onMouseLeave={() => setIsPanning(false)}
              className={`relative w-full rounded border border-slate-800 bg-black overflow-hidden ${
                previewZoomPct > 100 ? 'cursor-grab active:cursor-grabbing' : ''
              }`}
            >
              <video
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={effectiveMediaUrl}
                controls
                preload="metadata"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onLoadedMetadata={(e) => {
                  const vid = e.currentTarget;
                  if (vid.duration && Number.isFinite(vid.duration)) {
                    setDuration(vid.duration);
                  }
                }}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setCurrentTime(t);
                  onTimeUpdateSec?.(t);
                  if (
                    intervalEndSec !== undefined &&
                    intervalStartSec !== undefined &&
                    t >= intervalEndSec
                  ) {
                    if (loopInterval) {
                      e.currentTarget.currentTime = intervalStartSec;
                    }
                  }
                }}
                style={{
                  transform: `scale(${previewZoomPct / 100}) translate(${
                    panOffset.x / (previewZoomPct / 100)
                  }px, ${panOffset.y / (previewZoomPct / 100)}px)`,
                  transformOrigin: 'center center',
                  transition: isPanning ? 'none' : 'transform 150ms ease-out',
                }}
                className={`w-full bg-black object-contain ${
                  compact ? 'max-h-48' : 'max-h-72'
                }`}
              />
              {previewZoomPct !== 100 && (
                <div className="absolute top-2 right-2 bg-slate-900/90 border border-slate-700 text-white text-[10px] font-mono px-2 py-0.5 rounded pointer-events-none">
                  Preview Zoom: {previewZoomPct}% (Drag to Pan)
                </div>
              )}
            </div>
          ) : effectiveMediaUrl ? (
            <div className="p-4 bg-slate-900 rounded border border-slate-800">
              <audio
                ref={mediaRef as React.RefObject<HTMLAudioElement>}
                src={effectiveMediaUrl}
                controls
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onLoadedMetadata={(e) => {
                  if (e.currentTarget.duration && Number.isFinite(e.currentTarget.duration)) {
                    setDuration(e.currentTarget.duration);
                  }
                }}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setCurrentTime(t);
                  onTimeUpdateSec?.(t);
                }}
                className="w-full"
              />
            </div>
          ) : (
            <div className="p-6 text-center text-xs text-slate-400 bg-slate-900 rounded border border-slate-800">
              Transcript-only source attached ({formatTimestamp(totalDur)} calibrated duration).
            </div>
          )}
        </div>

        {/* Interactive Transport, Scrubber, Frame Step, Volume, Zoom & Quick Navigation */}
        <div
          className={`${
            compact ? 'lg:col-span-7' : 'lg:col-span-5'
          } flex flex-col justify-between space-y-2.5 text-slate-200`}
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-white">Timeline Scrubber</span>
              <span className="font-mono text-emerald-400">
                {formatTimestamp(currentTime)} ({Math.round(currentTime * 10) / 10}s) /{' '}
                {formatTimestamp(totalDur)} ({Math.round(totalDur)}s)
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={totalDur}
              step={0.1}
              value={Math.min(currentTime, totalDur)}
              onChange={handleSeekBarChange}
              aria-label="Seek video timeline"
              className="w-full accent-blue-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
            />
            {intervalStartSec !== undefined && intervalEndSec !== undefined && (
              <div className="flex items-center justify-between text-[11px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded">
                <span>
                  Active Clip Interval: {formatTimestamp(intervalStartSec)} –{' '}
                  {formatTimestamp(intervalEndSec)} (
                  {Math.round((intervalEndSec - intervalStartSec) * 10) / 10}s)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={playIntervalSegment}
                    className="underline font-semibold hover:text-white"
                  >
                    Play Clip Window
                  </button>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={loopInterval}
                      onChange={(e) => setLoopInterval(e.target.checked)}
                    />
                    Loop
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Primary Transport + Frame Stepping */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-800">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={togglePlay}
                className="text-xs font-semibold px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 active:scale-95 transition-all"
              >
                {isPlaying ? 'Pause' : 'Play Source'}
              </button>
              <button
                type="button"
                onClick={() => stepFrame(-1)}
                title="Step backward 1 frame (Shortcut: ,)"
                className="text-[11px] font-mono px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                -1f
              </button>
              <button
                type="button"
                onClick={() => stepFrame(1)}
                title="Step forward 1 frame (Shortcut: .)"
                className="text-[11px] font-mono px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                +1f
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mediaRef.current) {
                    const next = Math.max(0, mediaRef.current.currentTime - 10);
                    mediaRef.current.currentTime = next;
                    setCurrentTime(next);
                  }
                }}
                className="text-[11px] font-mono px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                -10s
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mediaRef.current) {
                    const next = Math.min(totalDur, mediaRef.current.currentTime + 10);
                    mediaRef.current.currentTime = next;
                    setCurrentTime(next);
                  }
                }}
                className="text-[11px] font-mono px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                +10s
              </button>
            </div>

            <div className="flex items-center gap-1">
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => handleRateChange(rate)}
                  className={`text-[11px] font-mono px-1.5 py-1 rounded transition-colors ${
                    playbackRate === rate
                      ? 'bg-blue-600 text-white font-bold'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>

          {/* Volume, Visual Preview Zoom & Fullscreen Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-800/80 text-[11px]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                className="font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                {isMuted || volume === 0 ? 'Unmute' : 'Vol'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                aria-label="Audio volume"
                className="w-20 accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded"
              />
            </div>

            {hasVideo && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-slate-400 font-mono mr-0.5">Zoom:</span>
                <button
                  type="button"
                  onClick={() => handleZoomChange(previewZoomPct - 25)}
                  aria-label="Zoom out preview"
                  className="font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  −
                </button>
                <span className="font-mono text-emerald-400 px-1.5 min-w-[42px] text-center">
                  {previewZoomPct}%
                </span>
                <button
                  type="button"
                  onClick={() => handleZoomChange(previewZoomPct + 25)}
                  aria-label="Zoom in preview"
                  className="font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => handleZoomChange(100)}
                  className="font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Reset Fit
                </button>
                <button
                  type="button"
                  onClick={handleFullscreen}
                  className="font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Fullscreen
                </button>
              </div>
            )}
          </div>

          {onOpenSection && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => onOpenSection('transcript')}
                className="text-[11px] font-semibold px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                03. Synced Transcript
              </button>
              <button
                type="button"
                onClick={() => onOpenSection('clips')}
                className="text-[11px] font-semibold px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                06. Short-Form Video Clips (≤120s)
              </button>
              <button
                type="button"
                onClick={() => onOpenSection('assets')}
                className="text-[11px] font-semibold px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                05. Written Assets
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SANITIZED DIAGNOSTIC ALERT CARD WITH COLLAPSIBLE TECHNICAL DETAILS DRAWER
// ============================================================================
interface DiagnosticAlertCardProps {
  title: string;
  userMessage: string;
  remediation?: string;
  diagnostic?: DiagnosticRecord;
  timestamp?: string;
  onRetry?: () => void;
  onEditClip?: () => void;
  onViewSource?: () => void;
  onDismiss?: () => void;
}

export const DiagnosticAlertCard: React.FC<DiagnosticAlertCardProps> = ({
  title,
  userMessage,
  remediation,
  diagnostic,
  timestamp,
  onRetry,
  onEditClip,
  onViewSource,
  onDismiss,
}) => {
  const [showTechnicalDrawer, setShowTechnicalDrawer] = useState(false);

  return (
    <div className="bg-amber-50/90 border border-amber-200 rounded-md p-3.5 text-xs text-slate-800 transition-all">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1 max-w-3xl">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-600" />
            <span className="font-bold text-slate-900">{title}</span>
            {diagnostic?.category && (
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                {diagnostic.category}
              </span>
            )}
            {timestamp && (
              <span className="text-[11px] font-mono text-slate-500">
                {new Date(timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
          <p className="text-slate-800 font-medium leading-relaxed">{userMessage}</p>
          {(remediation || diagnostic?.remediation) && (
            <p className="text-[11px] text-slate-600">
              <span className="font-semibold text-slate-700">Recommended Action:</span>{' '}
              {remediation || diagnostic?.remediation}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-xs font-semibold px-2.5 py-1 rounded bg-slate-900 text-white hover:bg-slate-800 transition-colors"
            >
              Retry Render
            </button>
          )}
          {onEditClip && (
            <button
              type="button"
              onClick={onEditClip}
              className="text-xs font-semibold px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            >
              Edit Clip
            </button>
          )}
          {onViewSource && (
            <button
              type="button"
              onClick={onViewSource}
              className="text-xs font-semibold px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            >
              View Source
            </button>
          )}
          {diagnostic && (
            <button
              type="button"
              onClick={() => setShowTechnicalDrawer((prev) => !prev)}
              className="text-xs font-mono px-2.5 py-1 rounded border border-amber-300 bg-amber-100/70 text-amber-900 hover:bg-amber-100 transition-colors"
            >
              {showTechnicalDrawer ? 'Hide Technical Details' : 'Technical Details'}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {showTechnicalDrawer && diagnostic && (
        <div className="mt-3 pt-3 border-t border-amber-200/80 bg-slate-900 text-slate-200 rounded p-3 font-mono text-[11px] space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
            <span>Diagnostic ID / Job: {diagnostic.jobId || 'N/A'}</span>
            <span>Stage: {diagnostic.stage}</span>
            {diagnostic.exitCode !== undefined && (
              <span>Exit Code: {diagnostic.exitCode}</span>
            )}
            <span>Timestamp: {diagnostic.timestamp}</span>
          </div>
          {diagnostic.configSummary && (
            <div className="text-amber-300">
              Configuration: {diagnostic.configSummary}
            </div>
          )}
          <div className="text-slate-300 bg-slate-950 p-2 rounded border border-slate-800 break-words">
            {diagnostic.sanitizedTechnicalDetail}
          </div>
        </div>
      )}
    </div>
  );
};

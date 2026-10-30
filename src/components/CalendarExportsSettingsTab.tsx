import React, { useState } from 'react';
import {
  Archive,
  Calendar as CalendarIcon,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  List,
  RefreshCw,
  Save,
  Settings,
  Trash2,
} from 'lucide-react';
import { generateCalendarCsv, generateCutSheetCsv } from '../lib/coreLogic';
import type {
  CalendarEntry,
  ContentCategory,
  ExportPackageRecord,
  FullProjectBundle,
} from '../types/domain';

interface CalendarProps {
  bundle: FullProjectBundle;
  onUpdateCalendar: (payload: {
    regenerate?: boolean;
    campaignStartDate?: string;
    preferredPublishingDays?: string[];
    entries?: CalendarEntry[];
  }) => Promise<void>;
  onNavigateSection: (section: string) => void;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const CATEGORIES: ContentCategory[] = [
  'Educational',
  'Opinion-Led',
  'Story / Case',
  'Promotional',
];

export const ContentCalendarSection: React.FC<CalendarProps> = ({
  bundle,
  onUpdateCalendar,
  onNavigateSection,
}) => {
  const { project, calendar } = bundle;
  const [entries, setEntries] = useState<CalendarEntry[]>(calendar);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [startDate, setStartDate] = useState(
    project.config.campaignStartDate || '2026-11-02'
  );
  const [preferredDays, setPreferredDays] = useState<string[]>(
    project.config.preferredPublishingDays || ['Monday', 'Wednesday', 'Friday']
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  React.useEffect(() => {
    setEntries(calendar);
  }, [calendar]);

  const toggleDay = (day: string) => {
    setPreferredDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const handleRegenerate = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await onUpdateCalendar({
        regenerate: true,
        campaignStartDate: startDate,
        preferredPublishingDays: preferredDays,
      });
      setMsg(
        'Rebuilt deterministic 4-week distribution schedule balancing categories across selected days.'
      );
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEntries = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await onUpdateCalendar({ entries });
      setMsg('Saved custom calendar publication dates and order.');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const updateEntry = (
    id: string,
    field: keyof CalendarEntry,
    value: any
  ) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );
  };

  const moveOrder = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= entries.length) return;
    const copy = [...entries];
    const [removed] = copy.splice(index, 1);
    copy.splice(nextIndex, 0, removed);
    setEntries(copy.map((item, i) => ({ ...item, order: i + 1 })));
  };

  const downloadCsv = () => {
    const csv = generateCalendarCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `content-calendar-${project.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Step 9: Deterministic 4-Week Distribution Schedule · Proposed Schedule (No External Auto-Publishing Claimed)
          </p>
          <h2 className="text-xl font-bold text-slate-900">
            4-Week Content Distribution Calendar ({entries.length} Scheduled Items)
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded ${
                viewMode === 'grid'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              <CalendarIcon className="w-3.5 h-3.5" />
              4-Week Grid
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded ${
                viewMode === 'list'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              Editable List
            </button>
          </div>

          <button
            type="button"
            onClick={downloadCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          <button
            type="button"
            onClick={() => onNavigateSection('exports')}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Proceed to Package Export
          </button>
        </div>
      </div>

      {/* Scheduling Rules Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <label
                htmlFor="cal-start-date"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Campaign Start Date
              </label>
              <input
                id="cal-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <span className="block text-xs font-semibold text-slate-700 mb-1">
                Preferred Publishing Days
              </span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day) => {
                  const active = preferredDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {day.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={handleRegenerate}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Rebuild 4-Week Schedule
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleSaveEntries}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800"
          >
            <Save className="w-3.5 h-3.5" />
            Save Calendar Changes
          </button>
        </div>
      </div>

      {msg && (
        <div className="p-3 bg-slate-100 border border-slate-300 rounded text-xs font-medium text-slate-800">
          {msg}
        </div>
      )}

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((weekNum) => {
            const weekItems = entries.filter((e) => e.weekNumber === weekNum);
            return (
              <div
                key={weekNum}
                className="bg-white border border-slate-200 rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-sm font-bold text-slate-900">
                    Week 0{weekNum}
                  </h3>
                  <span className="text-xs text-slate-500 font-mono">
                    {weekItems.length} slots
                  </span>
                </div>

                {weekItems.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4 text-center">
                    No deliverables assigned to Week {weekNum}.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {weekItems.map((item) => (
                      <div
                        key={item.id}
                        className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <span className="font-mono font-semibold text-blue-700">
                            {item.scheduledDate} ({item.dayOfWeek.slice(0, 3)})
                          </span>
                          <span>{item.category}</span>
                        </div>
                        <p className="text-xs font-bold text-slate-900 line-clamp-2">
                          {item.title}
                        </p>
                        <p className="text-xs text-slate-600">
                          {item.platform} ·{' '}
                          {item.status === 'approved_ready'
                            ? 'Approved Asset'
                            : 'Scheduled Draft'}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="divide-y divide-slate-200">
            {entries.map((entry, idx) => (
              <div
                key={entry.id}
                className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-50/70"
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      aria-label={`Move ${entry.title} up`}
                      onClick={() => moveOrder(idx, -1)}
                      className="px-1.5 py-0.5 text-xs bg-slate-100 rounded hover:bg-slate-200"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${entry.title} down`}
                      onClick={() => moveOrder(idx, 1)}
                      className="px-1.5 py-0.5 text-xs bg-slate-100 rounded hover:bg-slate-200"
                    >
                      ↓
                    </button>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {entry.order}. {entry.title}
                    </p>
                    <p className="text-xs text-slate-500">
                      {entry.platform} · {entry.notes}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="date"
                    aria-label={`Date for ${entry.title}`}
                    value={entry.scheduledDate}
                    onChange={(e) =>
                      updateEntry(entry.id, 'scheduledDate', e.target.value)
                    }
                    className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded"
                  />
                  <select
                    aria-label={`Category for ${entry.title}`}
                    value={entry.category}
                    onChange={(e) =>
                      updateEntry(
                        entry.id,
                        'category',
                        e.target.value as ContentCategory
                      )
                    }
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * STEP 10: EXPORT SYSTEM & MANIFEST BUILDER
 */
interface ExportsProps {
  bundle: FullProjectBundle;
  onGenerateExportZip: (approvedOnly: boolean) => Promise<ExportPackageRecord>;
}

export const ExportsPackageSection: React.FC<ExportsProps> = ({
  bundle,
  onGenerateExportZip,
}) => {
  const { project, assets, clips, calendar, exports } = bundle;
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [latestExport, setLatestExport] = useState<ExportPackageRecord | null>(
    exports[0] || null
  );
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (exports[0]) setLatestExport(exports[0]);
  }, [exports]);

  const handleBuildZip = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = await onGenerateExportZip(approvedOnly);
      setLatestExport(record);
    } catch (err: any) {
      setError(err.message || 'Export package generation failed.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCutSheetCsv = () => {
    const csv = generateCutSheetCsv(clips);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cut-sheet-${project.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCalendarCsvFile = () => {
    const csv = generateCalendarCsv(calendar);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `content-calendar-${project.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Step 10: Complete ZIP Delivery Archive (/documents, /videos, /captions, /metadata + asset-manifest.json)
          </p>
          <h2 className="text-xl font-bold text-slate-900">
            Content Delivery Package & Export Manifest
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={downloadCutSheetCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Cut Sheet (.CSV)
          </button>
          <button
            type="button"
            onClick={downloadCalendarCsvFile}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Calendar (.CSV)
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Package Builder Card */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">
              Generate Structured Project ZIP Archive
            </h3>
            <p className="text-xs text-slate-600">
              Packages Markdown documents, FFmpeg-rendered MP4 video clips, synchronized SRT subtitle files, JSON/CSV cut sheets, 4-week calendar, and <code className="font-mono">asset-manifest.json</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4 shrink-0">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={approvedOnly}
                onChange={(e) => setApprovedOnly(e.target.checked)}
                className="rounded border-slate-300"
              />
              Include Approved Assets Only
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={handleBuildZip}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Archive className="w-4 h-4" />
              {busy ? 'Building ZIP Archive...' : 'Build & Export Project ZIP'}
            </button>
          </div>
        </div>

        {/* Directory Structure Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-4 border-t border-slate-100">
          <div className="lg:col-span-5 bg-slate-900 text-slate-100 p-4 rounded-md font-mono text-xs space-y-1">
            <p className="text-slate-400 mb-2">Archive Hierarchy Specification:</p>
            <p>/{project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/</p>
            <p className="pl-4">├── /documents/</p>
            <p className="pl-8 text-emerald-300">├── blog.md</p>
            <p className="pl-8 text-emerald-300">├── newsletter.md</p>
            <p className="pl-8 text-emerald-300">├── linkedin-posts.md</p>
            <p className="pl-8 text-emerald-300">├── show-notes.md</p>
            <p className="pl-8 text-emerald-300">├── video-title-pack.md</p>
            <p className="pl-8 text-emerald-300">├── social-caption-pack.md</p>
            <p className="pl-8 text-emerald-300">├── youtube-description.md</p>
            <p className="pl-8 text-emerald-300">└── faq-guide.md</p>
            <p className="pl-4">├── /videos/</p>
            <p className="pl-8 text-blue-300">
              └── {clips.filter((c) => c.outputVideoUrl).map((c) => `${c.id}.mp4`).join(', ') || 'clip-01.mp4'}
            </p>
            <p className="pl-4">├── /captions/</p>
            <p className="pl-8 text-amber-300">
              └── {clips.map((c) => `${c.id}.srt`).join(', ')}
            </p>
            <p className="pl-4">└── /metadata/</p>
            <p className="pl-8 text-slate-300">├── content-calendar.json & .csv</p>
            <p className="pl-8 text-slate-300">├── cut-sheet.json & .csv</p>
            <p className="pl-8 text-slate-300">└── asset-manifest.json</p>
          </div>

          <div className="lg:col-span-7 space-y-4">
            {latestExport ? (
              <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-emerald-950">
                      Ready Archive: {latestExport.zipFilename}
                    </p>
                    <p className="text-xs text-emerald-800">
                      Built {latestExport.createdAt.slice(0, 19).replace('T', ' ')} ·{' '}
                      {latestExport.manifest.totalFiles} verified files in manifest
                    </p>
                  </div>
                  <a
                    href={latestExport.downloadUrl}
                    download={latestExport.zipFilename}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-md hover:bg-emerald-800 whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download ZIP Package
                  </a>
                </div>

                <div className="bg-white border border-emerald-200 rounded p-3 max-h-56 overflow-y-auto">
                  <p className="text-xs font-semibold text-slate-800 mb-2">
                    Manifest File Inventory ({latestExport.manifest.items.length} Deliverable Files):
                  </p>
                  <div className="divide-y divide-slate-100 text-xs">
                    {latestExport.manifest.items.map((item, i) => (
                      <div
                        key={i}
                        className="py-1.5 flex items-center justify-between gap-2"
                      >
                        <span className="font-mono text-slate-800 truncate">
                          {item.archivePath}
                        </span>
                        <span className="text-slate-500 font-mono shrink-0">
                          {item.status} · {(item.sizeBytes / 1024).toFixed(1)} KB
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 border border-dashed border-slate-300 rounded-lg text-center space-y-2">
                <p className="text-xs font-semibold text-slate-700">
                  Click "Build & Export Project ZIP" above to generate your downloadable package and inspect its manifest.
                </p>
                <p className="text-xs text-slate-500">
                  Currently {assets.length} written assets and {clips.length} video clip cut sheets ready for packaging.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * SECTION 10: PROJECT SETTINGS, RENDER QUEUE, COST CONTROLS & DATA DELETION
 */
interface SettingsProps {
  bundle: FullProjectBundle;
  onUpdateProject: (payload: Record<string, any>) => Promise<void>;
  onDeleteProject: () => Promise<void>;
}

export const ProjectSettingsSection: React.FC<SettingsProps> = ({
  bundle,
  onUpdateProject,
  onDeleteProject,
}) => {
  const { project } = bundle;
  const [aiModel, setAiModel] = useState(project.config.aiModel);
  const [minDur, setMinDur] = useState(project.config.clipMinDurationSec);
  const [maxDur, setMaxDur] = useState(
    Math.min(120, project.config.clipMaxDurationSec || 60)
  );
  const [allowOutliers, setAllowOutliers] = useState(
    project.config.allowDurationOutliers
  );
  const [blogLength, setBlogLength] = useState(project.config.blogTargetLength);
  const [nlTone, setNlTone] = useState(project.config.newsletterTone);
  const [maxConcurrency, setMaxConcurrency] = useState(
    project.config.renderQueueConfig?.maxConcurrency || 1
  );
  const [jobTimeoutSec, setJobTimeoutSec] = useState(
    project.config.renderQueueConfig?.jobTimeoutSec || 180
  );
  const [maxRetryCount, setMaxRetryCount] = useState(
    project.config.renderQueueConfig?.maxRetryCount || 2
  );
  const [defaultCaptionScriptMode, setDefaultCaptionScriptMode] = useState(
    project.config.defaultCaptionScriptMode || 'romanised'
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const clampedMaxDur = Math.min(120, Math.max(20, Number(maxDur)));
    setMaxDur(clampedMaxDur);
    await onUpdateProject({
      config: {
        ...project.config,
        aiModel,
        defaultCaptionScriptMode,
        clipMinDurationSec: Number(minDur),
        clipMaxDurationSec: clampedMaxDur,
        allowDurationOutliers: allowOutliers,
        blogTargetLength: blogLength,
        newsletterTone: nlTone,
        renderQueueConfig: {
          maxConcurrency: Math.min(2, Math.max(1, Number(maxConcurrency))),
          maxQueuedJobs: 20,
          jobTimeoutSec: Math.min(600, Math.max(60, Number(jobTimeoutSec))),
          maxRetryCount: Math.min(5, Math.max(0, Number(maxRetryCount))),
          tempFileRetentionMinutes: 30,
        },
      },
    });
    setSavedMsg('Saved project configuration, Default Caption Script Mode, <=120s short-form limits, and FFmpeg render queue policy.');
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="border-b border-slate-200 pb-4">
        <p className="text-xs font-medium text-slate-500">
          Step 10: Model Selection · Default Caption Script Mode · Short-Form Duration Cap (&le;120s) · FFmpeg Queue Concurrency
        </p>
        <h2 className="text-xl font-bold text-slate-900">
          Project Configuration & Privacy Controls
        </h2>
      </div>

      {savedMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs font-medium text-emerald-900">
          {savedMsg}
        </div>
      )}

      <form
        onSubmit={handleSaveSettings}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="settings-ai-model"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Configured Gemini AI Model
            </label>
            <select
              id="settings-ai-model"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value as any)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
            >
              <option value="gemini-3.8-flash">
                gemini-3.8-flash (Balanced Speed & Reasoning)
              </option>
              <option value="gemini-3.1-flash-lite">
                gemini-3.1-flash-lite (Lowest Cost High-Throughput)
              </option>
            </select>
          </div>

          <div>
            <label
              htmlFor="settings-caption-script-mode"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Default Caption Script Mode
            </label>
            <select
              id="settings-caption-script-mode"
              value={defaultCaptionScriptMode}
              onChange={(e) => setDefaultCaptionScriptMode(e.target.value as any)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white font-medium"
            >
              <option value="romanised">Romanised (Hinglish / Latin)</option>
              <option value="original">Original Script (Devanagari / Native)</option>
              <option value="both">Both (Original + Romanised)</option>
              <option value="translation">Translated Captions (English)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="settings-blog-len"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Target SEO Blog Length
            </label>
            <select
              id="settings-blog-len"
              value={blogLength}
              onChange={(e) => setBlogLength(e.target.value as any)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
            >
              <option value="concise (800 words)">Concise (~800 words)</option>
              <option value="standard (1,200 words)">Standard (~1,200 words)</option>
              <option value="comprehensive (1,800+ words)">
                Comprehensive (1,800+ words)
              </option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="settings-min-clip"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Min Clip Duration (s)
            </label>
            <input
              id="settings-min-clip"
              type="number"
              min={10}
              max={60}
              value={minDur}
              onChange={(e) => setMinDur(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
            />
          </div>
          <div>
            <label
              htmlFor="settings-max-clip"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Max Short-Form Duration (&le;120s)
            </label>
            <input
              id="settings-max-clip"
              type="number"
              min={20}
              max={120}
              value={maxDur}
              onChange={(e) => setMaxDur(Math.min(120, Number(e.target.value)))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={allowOutliers}
                onChange={(e) => setAllowOutliers(e.target.checked)}
              />
              Allow Sub-120s Outliers (e.g. 90–120s)
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100">
          <p className="text-xs font-bold text-slate-800 mb-3">
            FFmpeg Rendering Queue & Concurrency Policy
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="settings-render-concurrency"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Max Concurrent Renders
              </label>
              <select
                id="settings-render-concurrency"
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md bg-white"
              >
                <option value={1}>1 (Conservative Default)</option>
                <option value={2}>2 (Dual Worker Slots)</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="settings-render-timeout"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Job Timeout (s)
              </label>
              <input
                id="settings-render-timeout"
                type="number"
                min={60}
                max={600}
                value={jobTimeoutSec}
                onChange={(e) => setJobTimeoutSec(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
              />
            </div>
            <div>
              <label
                htmlFor="settings-render-retries"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Auto-Fallback Retries
              </label>
              <input
                id="settings-render-retries"
                type="number"
                min={0}
                max={5}
                value={maxRetryCount}
                onChange={(e) => setMaxRetryCount(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
              />
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-200 flex justify-end">
          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800"
          >
            Save Configuration
          </button>
        </div>
      </form>

      {/* Danger Zone: Delete Project Data */}
      <div className="bg-white border border-red-200 rounded-lg p-6 space-y-3">
        <h3 className="text-sm font-bold text-red-900">
          Delete Project & Associated Media Files
        </h3>
        <p className="text-xs text-slate-600">
          Permanently removes this project record, its transcript, generated deliverables, and any uploaded or FFmpeg-rendered video files from local storage.
        </p>
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete Project Data
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onDeleteProject}
              className="px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-700"
            >
              Confirm Permanent Deletion
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

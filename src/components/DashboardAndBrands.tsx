import React, { useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  Building2,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  FileText,
  Film,
  FolderPlus,
  HardDrive,
  Layers,
  Plus,
  Search,
  Sliders,
  Trash2,
} from 'lucide-react';
import { fetchJson } from '../lib/apiClient';
import { sanitizeOperationalError } from '../lib/coreLogic';
import { DiagnosticAlertCard } from './PersistentMediaInspector';
import type {
  BrandProfile,
  ExportPackageRecord,
  PlatformType,
  Project,
  SourceType,
} from '../types/domain';

export interface ProjectSummary extends Project {
  brandName: string;
  totalAssetsCount: number;
  approvedAssetsCount: number;
  renderedClipsCount: number;
  exportsCount: number;
}

export interface StorageHealthInfo {
  configuredPath: string;
  effectivePath: string;
  backendType: 'local-filesystem' | 'container-fallback';
  isWritable: boolean;
  configuredTargetAccessible: boolean;
  freeDiskSpaceGb: number | null;
  totalDiskSpaceGb: number | null;
  fallbackReason?: string;
}

export interface SystemInfo {
  geminiConfigured: boolean;
  defaultModel: string;
  ffmpegAvailable: boolean;
  storageLocation: string;
  configuredStoragePath?: string;
  storageFallbackReason?: string;
  storagePlatform?: string;
  storageHealth?: StorageHealthInfo;
  maxUploadSizeMb: number;
  maxRenderConcurrency: number;
  activeRenderCount: number;
  queuedRenderCount?: number;
}

interface DeletePreviewData {
  projectId: string;
  projectName: string;
  sourceFileName: string | null;
  sourceFileShared: boolean;
  transcriptSegmentsCount: number;
  writtenAssetsCount: number;
  videoClipsCount: number;
  renderedClipFilesCount: number;
  exportArchivesCount: number;
  activeRenderJobsCount: number;
}

interface DashboardProps {
  projects: ProjectSummary[];
  brands: BrandProfile[];
  recentExports: ExportPackageRecord[];
  systemInfo: SystemInfo | null;
  activeBrandFilter: string;
  setActiveBrandFilter: (id: string) => void;
  onSelectProject: (projectId: string, initialSection?: string) => void;
  onOpenNewProjectModal: () => void;
  onNavigateBrands: () => void;
  onRefreshStudio?: () => Promise<any>;
}

export const StudioDashboardView: React.FC<DashboardProps> = ({
  projects,
  brands,
  recentExports,
  systemInfo,
  activeBrandFilter,
  setActiveBrandFilter,
  onSelectProject,
  onOpenNewProjectModal,
  onNavigateBrands,
  onRefreshStudio,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived'>(
    'active'
  );

  // Project Management Actions state (Priority 6)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(
    null
  );
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [deleteModalData, setDeleteModalData] =
    useState<DeletePreviewData | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const activeProjectsCount = projects.filter((p) => !p.archived).length;
  const archivedProjectsCount = projects.filter((p) => Boolean(p.archived)).length;

  const filteredProjects = projects.filter((p) => {
    const matchesArchive =
      archiveFilter === 'archived' ? Boolean(p.archived) : !p.archived;
    const matchesBrand =
      activeBrandFilter === 'all' || p.brandId === activeBrandFilter;
    const matchesStatus =
      statusFilter === 'all' || p.status === statusFilter;
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sourceTitle.toLowerCase().includes(q) ||
      p.brandName.toLowerCase().includes(q);
    return matchesArchive && matchesBrand && matchesStatus && matchesSearch;
  });

  const handleStartRename = (project: ProjectSummary) => {
    setRenamingProjectId(project.id);
    setRenameDraft(project.name);
  };

  const handleSaveRename = async (projectId: string) => {
    if (!renameDraft.trim()) return;
    setActionBusy(true);
    try {
      await fetchJson(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameDraft.trim() }),
      });
      setRenamingProjectId(null);
      await onRefreshStudio?.();
      setActionFeedback({
        type: 'success',
        text: `Renamed project to "${renameDraft.trim()}".`,
      });
    } catch (err: any) {
      setActionFeedback({ type: 'error', text: err.message });
    } finally {
      setActionBusy(false);
    }
  };

  const handleDuplicateProject = async (project: ProjectSummary) => {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      await fetchJson(`/api/projects/${project.id}/duplicate`, {
        method: 'POST',
      });
      await onRefreshStudio?.();
      setActionFeedback({
        type: 'success',
        text: `Duplicated "${project.name}" with all transcript segments, written assets, and clip configurations.`,
      });
    } catch (err: any) {
      setActionFeedback({ type: 'error', text: err.message });
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleArchiveProject = async (project: ProjectSummary) => {
    setActionBusy(true);
    setActionFeedback(null);
    const nextArchived = !project.archived;
    try {
      await fetchJson(`/api/projects/${project.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: nextArchived }),
      });
      await onRefreshStudio?.();
      setActionFeedback({
        type: 'success',
        text: nextArchived
          ? `Archived "${project.name}". Switch to the Archived view anytime to restore it.`
          : `Restored "${project.name}" to Active Projects.`,
      });
    } catch (err: any) {
      setActionFeedback({ type: 'error', text: err.message });
    } finally {
      setActionBusy(false);
    }
  };

  const handleOpenDeleteConfirm = async (project: ProjectSummary) => {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const preview = await fetchJson<DeletePreviewData>(
        `/api/projects/${project.id}/delete-preview`
      );
      setDeleteModalData(preview);
    } catch (err: any) {
      setActionFeedback({ type: 'error', text: err.message });
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmDeleteProject = async () => {
    if (!deleteModalData) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/projects/${deleteModalData.projectId}`, {
        method: 'DELETE',
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(body.error || 'Failed to delete project.');
      }
      const deletedName = deleteModalData.projectName;
      setDeleteModalData(null);
      await onRefreshStudio?.();
      setActionFeedback({
        type: 'success',
        text: `Permanently deleted project "${deletedName}" and cleaned up its unshared project files.`,
      });
    } catch (err: any) {
      setActionFeedback({ type: 'error', text: err.message });
    } finally {
      setActionBusy(false);
    }
  };

  const totalAssets = projects.reduce((acc, p) => acc + p.totalAssetsCount, 0);
  const totalApproved = projects.reduce(
    (acc, p) => acc + p.approvedAssetsCount,
    0
  );
  const totalRenderedClips = projects.reduce(
    (acc, p) => acc + p.renderedClipsCount,
    0
  );
  const allFailedTasks = projects.flatMap((p) =>
    p.failedTasks.map((t) => ({ ...t, projectId: p.id, projectName: p.name }))
  );

  return (
    <div className="space-y-8">
      {/* Studio Header & Primary Action */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1">
            One Source · One Content Strategy · Coordinated Multi-Format Assets
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Production Studio Overview
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onNavigateBrands}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            Manage Brand Profiles ({brands.length})
          </button>
          <button
            type="button"
            onClick={onOpenNewProjectModal}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Content Project
          </button>
        </div>
      </div>

      {actionFeedback && (
        <div
          className={`p-3.5 rounded-lg border text-xs font-medium flex items-center justify-between ${
            actionFeedback.type === 'error'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          <span>{actionFeedback.text}</span>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="text-xs underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Metric Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-white border border-slate-200 rounded-lg">
          <p className="text-xs text-slate-500">Active Content Projects</p>
          <p className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {activeProjectsCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Across {brands.length} configured brand profiles ({archivedProjectsCount} archived)
          </p>
        </div>
        <div className="p-5 bg-white border border-slate-200 rounded-lg">
          <p className="text-xs text-slate-500">Deliverables Generated</p>
          <p className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {totalAssets}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Blogs · Newsletters · LinkedIn · Video Cut Sheets
          </p>
        </div>
        <div className="p-5 bg-white border border-slate-200 rounded-lg">
          <p className="text-xs text-slate-500">Approved for Distribution</p>
          <p className="mt-2 text-2xl font-bold text-emerald-700 font-mono tabular-nums">
            {totalApproved}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Verified against source transcript segments
          </p>
        </div>
        <div className="p-5 bg-white border border-slate-200 rounded-lg">
          <p className="text-xs text-slate-500">Rendered FFmpeg Video Clips</p>
          <p className="mt-2 text-2xl font-bold text-blue-700 font-mono tabular-nums">
            {totalRenderedClips}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            9:16 portrait MP4s with synchronized SRT captions
          </p>
        </div>
      </div>

      {/* Search, Brand Selector & Filter Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-white p-4 border border-slate-200 rounded-lg">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            aria-label="Search projects"
            placeholder="Search projects by name, source title, or client brand..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 focus:bg-white"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Active vs Archived Toggle */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setArchiveFilter('active')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                archiveFilter === 'active'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Active ({activeProjectsCount})
            </button>
            <button
              type="button"
              onClick={() => setArchiveFilter('archived')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                archiveFilter === 'archived'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Archived ({archivedProjectsCount})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="dashboard-brand-filter"
              className="text-xs font-medium text-slate-600 whitespace-nowrap"
            >
              Brand:
            </label>
            <select
              id="dashboard-brand-filter"
              value={activeBrandFilter}
              onChange={(e) => setActiveBrandFilter(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:border-blue-600"
            >
              <option value="all">All Brands ({brands.length})</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['all', 'draft', 'transcribed', 'generated', 'ready_for_export'] as const).map(
              (st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'all'
                    ? 'All States'
                    : st.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Projects Table / List */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Content Repurposing Projects {archiveFilter === 'archived' ? '(Archived)' : ''}
          </h2>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            Showing {filteredProjects.length} of {projects.length}
          </span>
        </div>

        {filteredProjects.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-800">
              No projects match your current filter criteria.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Create a new content repurposing project or reset your search filters.
            </p>
            <button
              type="button"
              onClick={onOpenNewProjectModal}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              <FolderPlus className="w-4 h-4" />
              Create First Project
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                className="p-6 hover:bg-slate-50/80 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-6"
              >
                <div className="space-y-1.5 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">
                      {project.brandName}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{project.sourceType}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Stage: {project.status.replace(/_/g, ' ').toUpperCase()}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Updated {project.updatedAt.slice(0, 10)}
                    </span>
                    {project.archived && (
                      <span className="px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded font-mono text-[10px] uppercase">
                        Archived
                      </span>
                    )}
                  </div>

                  {renamingProjectId === project.id ? (
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        aria-label="New project name"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        className="px-2.5 py-1 text-sm font-semibold border border-blue-500 rounded bg-white text-slate-900"
                      />
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleSaveRename(project.id)}
                        className="px-2.5 py-1 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-700"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingProjectId(null)}
                        className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <h3 className="text-lg font-semibold text-slate-900">
                      <button
                        type="button"
                        onClick={() => onSelectProject(project.id, 'overview')}
                        className="text-left hover:text-blue-600 transition-colors"
                      >
                        {project.name}
                      </button>
                    </h3>
                  )}

                  <p className="text-xs text-slate-600">
                    Source: <span className="font-medium">{project.sourceTitle}</span> — Objective: {project.primaryObjective}
                  </p>

                  {/* Safe Project Management Action Strip (Priority 6) */}
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-500">
                    <button
                      type="button"
                      onClick={() => handleStartRename(project)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      <Edit3 className="w-3 h-3" /> Rename
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => handleDuplicateProject(project)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      <Copy className="w-3 h-3" /> Duplicate
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => handleToggleArchiveProject(project)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      <Archive className="w-3 h-3" />{' '}
                      {project.archived ? 'Restore' : 'Archive'}
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => handleOpenDeleteConfirm(project)}
                      className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-800 font-medium"
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-6 shrink-0">
                  <div className="text-right">
                    <p className="text-xs text-slate-500">Deliverables</p>
                    <p className="text-sm font-semibold text-slate-900 font-mono tabular-nums">
                      {project.approvedAssetsCount} / {project.totalAssetsCount} Approved
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500">Rendered Clips</p>
                    <p className="text-sm font-semibold text-slate-900 font-mono tabular-nums">
                      {project.renderedClipsCount} MP4 Ready
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id, 'source')}
                      className="px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0"
                    >
                      Upload / Source Video
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id, 'assets')}
                      className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      Review Assets
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id, 'clips')}
                      className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      Video Studio
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id, 'overview')}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                    >
                      Open Workspace
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Split: Recent Exports & Storage / Pipeline Readiness */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Recent Content Package Exports
            </h2>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {recentExports.length} archives
            </span>
          </div>

          {recentExports.length === 0 ? (
            <div className="py-6 text-center border border-dashed border-slate-200 rounded-md">
              <p className="text-xs text-slate-600">
                No ZIP packages exported yet in this session.
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Open a project’s Exports tab to build a downloadable delivery archive.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentExports.slice(0, 5).map((exp) => (
                <div
                  key={exp.id}
                  className="py-3 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-900">
                      {exp.zipFilename}
                    </p>
                    <p className="text-xs text-slate-500">
                      {exp.projectName} · {exp.manifest.totalFiles} files ·{' '}
                      <span className="font-mono tabular-nums">
                        {exp.createdAt.slice(0, 16).replace('T', ' ')}
                      </span>
                    </p>
                  </div>
                  <a
                    href={exp.downloadUrl}
                    download={exp.zipFilename}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download ZIP
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <HardDrive className="w-4 h-4 text-slate-700" />
              Storage Configuration & Pipeline Readiness
            </h2>
            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded border font-semibold ${
                systemInfo?.storageHealth?.isWritable !== false
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
              }`}
            >
              {systemInfo?.storageHealth?.isWritable !== false
                ? '✓ Verified Writable'
                : 'Read-Only Warning'}
            </span>
          </div>

          {/* Priority 10: Explicit Storage Backend, Path & Disk Space Grid */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-slate-500 block">Effective Storage Path</span>
              <code className="font-mono font-semibold text-slate-900 break-all">
                {systemInfo?.storageHealth?.effectivePath ||
                  systemInfo?.storageLocation ||
                  '/app/applet/storage'}
              </code>
            </div>
            <div>
              <span className="text-slate-500 block">Storage Backend & Disk Space</span>
              <span className="font-mono font-semibold text-slate-900">
                {systemInfo?.storageHealth?.backendType || 'container-fallback'}
                {systemInfo?.storageHealth?.freeDiskSpaceGb != null &&
                  ` · ${systemInfo.storageHealth.freeDiskSpaceGb} GB free`}
              </span>
            </div>
            {systemInfo?.configuredStoragePath && (
              <div className="sm:col-span-2 text-[11px] text-slate-500 border-t border-slate-200/80 pt-2">
                Configured Target:{' '}
                <code className="font-mono text-slate-700">
                  {systemInfo.configuredStoragePath}
                </code>{' '}
                —{' '}
                {systemInfo?.storageHealth?.configuredTargetAccessible
                  ? 'Directly Mounted'
                  : 'Safely routed to verified Linux container volume'}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs border-b border-slate-100 pb-4">
            <div>
              <p className="text-slate-500">Video Processing Engine</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {systemInfo?.ffmpegAvailable
                  ? `FFmpeg 4.4 Active · Queue: ${systemInfo.activeRenderCount || 0} active / ${systemInfo.queuedRenderCount || 0} waiting`
                  : 'FFmpeg Not Detected'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">AI Content Engine</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {systemInfo?.geminiConfigured
                  ? `Gemini API Active (${systemInfo.defaultModel})`
                  : 'Deterministic Extraction Engine Ready'}
              </p>
            </div>
          </div>

          {allFailedTasks.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-emerald-700 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Zero failed pipeline tasks across all projects.</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold text-amber-800">
                Tasks Requiring Attention ({allFailedTasks.length})
              </p>
              {allFailedTasks.slice(0, 3).map((t) => {
                const diag =
                  t.diagnostic ||
                  sanitizeOperationalError({
                    stage: t.stage,
                    rawError: t.message,
                  });
                return (
                  <DiagnosticAlertCard
                    key={t.id}
                    title={`${t.projectName} · ${t.stage.replace(/_/g, ' ').toUpperCase()}`}
                    userMessage={diag.userMessage}
                    remediation={diag.remediation}
                    diagnostic={diag}
                    timestamp={t.timestamp}
                    onRetry={() =>
                      onSelectProject(
                        t.projectId,
                        t.stage === 'video_render' ? 'clips' : 'overview'
                      )
                    }
                    onViewSource={() => onSelectProject(t.projectId, 'source')}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Safe Project Deletion Confirmation Modal (Priority 6) */}
      {deleteModalData && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-project-modal-title"
        >
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <h3
                  id="delete-project-modal-title"
                  className="text-base font-bold text-slate-900"
                >
                  Delete Project &ldquo;{deleteModalData.projectName}&rdquo;?
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  This action permanently removes the project and its unshared generated deliverables.
                </p>
              </div>
            </div>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1.5">
              <p className="font-semibold text-slate-800">
                Associated Project Inventory:
              </p>
              <ul className="list-disc pl-4 text-slate-600 space-y-0.5 font-mono">
                <li>
                  Source Media:{' '}
                  {deleteModalData.sourceFileName || 'None attached'}{' '}
                  {deleteModalData.sourceFileShared
                    ? '(Shared with another project — file will be preserved)'
                    : ''}
                </li>
                <li>
                  Transcript Segments: {deleteModalData.transcriptSegmentsCount}
                </li>
                <li>
                  Written Deliverables: {deleteModalData.writtenAssetsCount}
                </li>
                <li>
                  Video Clips: {deleteModalData.videoClipsCount} ({deleteModalData.renderedClipFilesCount} rendered MP4 files)
                </li>
                <li>
                  Export Archives: {deleteModalData.exportArchivesCount}
                </li>
              </ul>
            </div>

            {deleteModalData.activeRenderJobsCount > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 font-medium">
                Warning: {deleteModalData.activeRenderJobsCount} render job(s) are currently active for this project. Cancel or wait for active renders to finish before deleting.
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setDeleteModalData(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  actionBusy || deleteModalData.activeRenderJobsCount > 0
                }
                onClick={handleConfirmDeleteProject}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-md hover:bg-rose-700 disabled:opacity-50"
              >
                {actionBusy
                  ? 'Deleting...'
                  : 'Permanently Delete Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * CREATE NEW PROJECT MODAL (STEP 1 OF USER JOURNEY)
 */
interface NewProjectModalProps {
  isOpen: boolean;
  brands: BrandProfile[];
  onClose: () => void;
  onCreateProject: (payload: Record<string, any>) => Promise<void>;
  onSwitchToCreateBrand: () => void;
}

const SOURCE_TYPES: SourceType[] = [
  'Podcast',
  'Interview',
  'Webinar',
  'Founder Conversation',
  'Educational Video',
  'Product Demonstration',
  'Business Presentation',
  'Recorded Event',
];

const PLATFORM_OPTIONS: PlatformType[] = [
  'Blog / Organic Search',
  'Email Newsletter',
  'LinkedIn',
  'YouTube Shorts',
  'TikTok / Reels',
  'X (Twitter)',
  'Podcast Show Notes',
];

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  brands,
  onClose,
  onCreateProject,
  onSwitchToCreateBrand,
}) => {
  const [name, setName] = useState('');
  const [brandId, setBrandId] = useState(brands[0]?.id || '');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('Founder Conversation');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetAudience, setTargetAudience] = useState(
    'CTOs, VPs of Engineering, and Infrastructure Architects'
  );
  const [primaryObjective, setPrimaryObjective] = useState(
    'Educate technical decision-makers and generate qualified architecture audit requests'
  );
  const [desiredPlatforms, setDesiredPlatforms] = useState<PlatformType[]>([
    'Blog / Organic Search',
    'Email Newsletter',
    'LinkedIn',
    'YouTube Shorts',
  ]);
  const [desiredDeliverablesCount, setDesiredDeliverablesCount] = useState(6);
  const [publishingPeriodWeeks, setPublishingPeriodWeeks] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const togglePlatform = (plat: PlatformType) => {
    setDesiredPlatforms((prev) =>
      prev.includes(plat) ? prev.filter((p) => p !== plat) : [...prev, plat]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !sourceTitle.trim()) {
      setError('Please enter both a Project Name and a Source Title.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreateProject({
        name: name.trim(),
        brandId: brandId || brands[0]?.id,
        sourceTitle: sourceTitle.trim(),
        sourceType,
        sourceLanguage,
        targetAudience,
        primaryObjective,
        desiredPlatforms,
        desiredDeliverablesCount,
        publishingPeriodWeeks,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create project.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full p-6 space-y-5 shadow-xl my-8">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <h2
              id="new-project-modal-title"
              className="text-lg font-bold text-slate-900"
            >
              Create Content Repurposing Project
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Step 1: Define project scope, client brand profile, target audience, and desired deliverables.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="proj-name-input"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Project Name *
              </label>
              <input
                id="proj-name-input"
                type="text"
                required
                placeholder="e.g., Q1 Cloud Security Webinar Campaign"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="proj-brand-select"
                  className="text-xs font-semibold text-slate-700"
                >
                  Client or Brand Profile *
                </label>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onSwitchToCreateBrand();
                  }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  + New Brand
                </button>
              </div>
              <select
                id="proj-brand-select"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:border-blue-600"
              >
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.industry})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="proj-source-title"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Source Title *
              </label>
              <input
                id="proj-source-title"
                type="text"
                required
                placeholder="e.g., Zero-Trust Identity Architecture Fireside Chat"
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="proj-source-type"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Source Type
              </label>
              <select
                id="proj-source-type"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as SourceType)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:border-blue-600"
              >
                {SOURCE_TYPES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="proj-audience"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Target Audience
              </label>
              <input
                id="proj-audience"
                type="text"
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="proj-objective"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Primary Marketing Objective
              </label>
              <input
                id="proj-objective"
                type="text"
                value={primaryObjective}
                onChange={(e) => setPrimaryObjective(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-1.5">
              Desired Distribution Platforms
            </span>
            <div className="flex flex-wrap gap-2">
              {PLATFORM_OPTIONS.map((plat) => {
                const active = desiredPlatforms.includes(plat);
                return (
                  <button
                    key={plat}
                    type="button"
                    onClick={() => togglePlatform(plat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {plat}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="proj-lang"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Source Language
              </label>
              <select
                id="proj-lang"
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                <option value="auto">Auto-Detect Multilingual (auto)</option>
                <option value="en">English (en)</option>
                <option value="hi">Hindi / हिन्दी (hi)</option>
                <option value="hinglish">Hinglish / Code-Switched (hinglish)</option>
                <option value="gu">Gujarati / ગુજરાતી (gu)</option>
                <option value="es">Spanish (es)</option>
                <option value="de">German (de)</option>
                <option value="fr">French (fr)</option>
                <option value="ja">Japanese (ja)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="proj-deliverables-count"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Deliverables Count
              </label>
              <input
                id="proj-deliverables-count"
                type="number"
                min={3}
                max={15}
                value={desiredDeliverablesCount}
                onChange={(e) =>
                  setDesiredDeliverablesCount(Number(e.target.value || 6))
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono tabular-nums"
              />
            </div>

            <div>
              <label
                htmlFor="proj-weeks"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Publishing Period (Weeks)
              </label>
              <input
                id="proj-weeks"
                type="number"
                min={1}
                max={12}
                value={publishingPeriodWeeks}
                onChange={(e) =>
                  setPublishingPeriodWeeks(Number(e.target.value || 4))
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono tabular-nums"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Creating Project...' : 'Create Project & Proceed to Source'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * BRAND INTELLIGENCE SYSTEM MANAGER (SECTION 4)
 */
interface BrandManagerProps {
  brands: BrandProfile[];
  onSaveBrand: (
    brandPayload: Partial<BrandProfile>,
    isEdit: boolean
  ) => Promise<{ brand: BrandProfile; assumptionsMade: string[] }>;
}

export const BrandIntelligenceView: React.FC<BrandManagerProps> = ({
  brands,
  onSaveBrand,
}) => {
  const [selectedBrandId, setSelectedBrandId] = useState<string>(
    brands[0]?.id || 'new'
  );
  const activeBrand = brands.find((b) => b.id === selectedBrandId);

  const [formState, setFormState] = useState<Partial<BrandProfile>>(
    activeBrand || {
      name: '',
      companyDescription: '',
      industry: 'B2B Enterprise SaaS',
      businessModel: 'Subscription SaaS',
      productsAndServices: ['Core Platform'],
      targetAudiences: ['CTOs and Engineering Leaders'],
      primaryCustomerProblems: ['High operational overhead'],
      brandPositioning: '',
      uniqueDifferentiators: ['Deterministic verification'],
      brandVoice: 'Authoritative, empirical, practitioner-focused',
      writingStyle: 'Direct active prose, concrete metrics, zero fluff',
      preferredVocabulary: ['telemetry', 'unit economics'],
      wordsToAvoid: ['synergy', 'magic', 'game-changer'],
      approvedCallsToAction: ['Book a 15-minute architecture review.'],
      website: 'https://example.com',
      legalDisclaimers: 'Do not invent customer quotes or guaranteed ROI claims.',
    }
  );
  const [lastAssumptions, setLastAssumptions] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const selectBrand = (id: string) => {
    setSelectedBrandId(id);
    setSaveMessage(null);
    setLastAssumptions([]);
    if (id === 'new') {
      setFormState({
        name: '',
        companyDescription: '',
        industry: '',
        businessModel: 'B2B SaaS',
        productsAndServices: [],
        targetAudiences: [],
        primaryCustomerProblems: [],
        brandPositioning: '',
        uniqueDifferentiators: [],
        brandVoice: '',
        writingStyle: '',
        preferredVocabulary: [],
        wordsToAvoid: ['synergy', 'guaranteed viral'],
        approvedCallsToAction: [],
        website: '',
        legalDisclaimers: '',
      });
    } else {
      const found = brands.find((b) => b.id === id);
      if (found) setFormState(found);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMessage(null);
    const isEdit = selectedBrandId !== 'new';
    const result = await onSaveBrand(
      isEdit ? { ...formState, id: selectedBrandId } : formState,
      isEdit
    );
    setSelectedBrandId(result.brand.id);
    setFormState(result.brand);
    setLastAssumptions(result.assumptionsMade || []);
    setSaveMessage(`Saved brand profile "${result.brand.name}".`);
  };

  const splitList = (val: string) =>
    val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Persistent Multi-Brand Voice, Vocabulary, Visual & Legal Guardrails
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            Brand Intelligence System
          </h1>
        </div>
        <button
          type="button"
          onClick={() => selectBrand('new')}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Create New Brand Profile
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Brand List Sidebar */}
        <div className="lg:col-span-4 space-y-3">
          <h2 className="text-xs font-semibold text-slate-600">
            Saved Brand Profiles ({brands.length})
          </h2>
          <div className="space-y-2">
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => selectBrand(b.id)}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  selectedBrandId === b.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <p className="text-sm font-semibold">{b.name}</p>
                <p
                  className={`text-xs mt-1 ${
                    selectedBrandId === b.id ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {b.industry} · {b.businessModel}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Brand Profile Form */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-lg p-6">
          <h2 className="text-base font-bold text-slate-900 mb-1">
            {selectedBrandId === 'new'
              ? 'New Brand Profile Configuration'
              : `Editing Brand: ${formState.name}`}
          </h2>
          <p className="text-xs text-slate-500 mb-5">
            Every generated blog, newsletter, LinkedIn post, and video clip injects these brand constraints automatically. If fields are left blank, sensible defaults are applied and logged transparently.
          </p>

          {saveMessage && (
            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800 space-y-1">
              <p className="font-semibold">{saveMessage}</p>
              {lastAssumptions.length > 0 && (
                <div>
                  <p className="font-medium mt-1">
                    Default Assumptions Applied for Unspecified Fields:
                  </p>
                  <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                    {lastAssumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="brand-name"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Brand Name *
                </label>
                <input
                  id="brand-name"
                  type="text"
                  required
                  value={formState.name || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, name: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label
                  htmlFor="brand-industry"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Industry & Category
                </label>
                <input
                  id="brand-industry"
                  type="text"
                  value={formState.industry || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, industry: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="brand-model"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Business Model
                </label>
                <input
                  id="brand-model"
                  type="text"
                  value={formState.businessModel || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, businessModel: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label
                  htmlFor="brand-website"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Website URL
                </label>
                <input
                  id="brand-website"
                  type="text"
                  value={formState.website || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, website: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="brand-desc"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Company Description & Positioning
              </label>
              <textarea
                id="brand-desc"
                rows={2}
                value={formState.companyDescription || ''}
                onChange={(e) =>
                  setFormState({
                    ...formState,
                    companyDescription: e.target.value,
                  })
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="brand-voice"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Brand Voice
                </label>
                <input
                  id="brand-voice"
                  type="text"
                  placeholder="e.g., Empirical, direct, principal engineer tone"
                  value={formState.brandVoice || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, brandVoice: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label
                  htmlFor="brand-style"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Writing Style Guidelines
                </label>
                <input
                  id="brand-style"
                  type="text"
                  value={formState.writingStyle || ''}
                  onChange={(e) =>
                    setFormState({ ...formState, writingStyle: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="brand-products"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Products & Services (comma-separated)
                </label>
                <input
                  id="brand-products"
                  type="text"
                  value={(formState.productsAndServices || []).join(', ')}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      productsAndServices: splitList(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label
                  htmlFor="brand-audiences"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Target Audiences (comma-separated)
                </label>
                <input
                  id="brand-audiences"
                  type="text"
                  value={(formState.targetAudiences || []).join(', ')}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      targetAudiences: splitList(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="brand-vocab"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Preferred Vocabulary (comma-separated)
                </label>
                <input
                  id="brand-vocab"
                  type="text"
                  value={(formState.preferredVocabulary || []).join(', ')}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      preferredVocabulary: splitList(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label
                  htmlFor="brand-avoid"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Words & Phrases to Avoid (comma-separated)
                </label>
                <input
                  id="brand-avoid"
                  type="text"
                  value={(formState.wordsToAvoid || []).join(', ')}
                  onChange={(e) =>
                    setFormState({
                      ...formState,
                      wordsToAvoid: splitList(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="brand-ctas"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Approved Calls to Action (comma-separated)
              </label>
              <input
                id="brand-ctas"
                type="text"
                value={(formState.approvedCallsToAction || []).join(', ')}
                onChange={(e) =>
                  setFormState({
                    ...formState,
                    approvedCallsToAction: splitList(e.target.value),
                  })
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <label
                htmlFor="brand-disclaimers"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Legal Disclaimers & Claim Restrictions
              </label>
              <textarea
                id="brand-disclaimers"
                rows={2}
                value={formState.legalDisclaimers || ''}
                onChange={(e) =>
                  setFormState({
                    ...formState,
                    legalDisclaimers: e.target.value,
                  })
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>

            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Save Brand Profile
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

/**
 * ARCHITECTURE, SETUP & TROUBLESHOOTING DOCUMENTATION VIEW
 */
export const StudioDocumentationView: React.FC<{ systemInfo: SystemInfo | null }> = ({
  systemInfo,
}) => {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="border-b border-slate-200 pb-4">
        <p className="text-xs font-medium text-slate-500">
          Architecture · FFmpeg Pipeline · Gemini API Configuration · Security & Testing
        </p>
        <h1 className="text-2xl font-bold text-slate-900">
          Studio Operations & Setup Documentation
        </h1>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <h2 className="text-base font-bold text-slate-900">
          1. System Architecture & Data Storage
        </h2>
        <p className="text-sm text-slate-700 leading-relaxed">
          Strata Studio follows a strict single-source-of-truth pipeline: long-form video or transcript sources are ingested and normalized into timestamped segments, analyzed into a source-linked Content Intelligence Report, structured into a multi-angle Content Strategy, and transformed into platform-specific written deliverables and FFmpeg-rendered vertical video clips.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs bg-slate-50 p-4 rounded-md border border-slate-200">
          <div>
            <p className="font-semibold text-slate-900">Local Storage Paths</p>
            <ul className="mt-1 space-y-1 text-slate-600 font-mono">
              <li>./storage/db.json (Metadata & State)</li>
              <li>./storage/uploads/ (Uploaded Media)</li>
              <li>./storage/renders/ (FFmpeg MP4 & SRT Clips)</li>
              <li>./storage/exports/ (Downloadable ZIP Packages)</li>
            </ul>
          </div>
          <div>
            <p className="font-semibold text-slate-900">Runtime Status</p>
            <ul className="mt-1 space-y-1 text-slate-600">
              <li>FFmpeg Binary: {systemInfo?.ffmpegAvailable ? 'Verified (/usr/bin/ffmpeg)' : 'Missing'}</li>
              <li>Gemini API Server Key: {systemInfo?.geminiConfigured ? 'Configured' : 'Using Deterministic Local Extractor'}</li>
              <li>Max Upload Limit: {systemInfo?.maxUploadSizeMb || 250} MB</li>
              <li>Max Concurrent Renders: {systemInfo?.maxRenderConcurrency || 2} jobs</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
        <h2 className="text-base font-bold text-slate-900">
          2. Environment Configuration & API Credentials
        </h2>
        <p className="text-sm text-slate-700">
          All AI provider calls execute strictly on the server via <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">@google/genai</code>. API keys are never exposed to client bundles. Configure variables in <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">.env</code> (see <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">.env.example</code>):
        </p>
        <pre className="p-4 bg-slate-900 text-slate-100 rounded-md text-xs font-mono overflow-x-auto">
{`GEMINI_API_KEY="your-server-side-gemini-api-key"
DEFAULT_GEMINI_MODEL="gemini-3.8-flash"
TRANSCRIPTION_GEMINI_MODEL="gemini-3.5-transcribe"
FFMPEG_PATH="/usr/bin/ffmpeg"
MAX_UPLOAD_SIZE_MB="250"
MAX_RENDER_CONCURRENCY="2"`}
        </pre>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
        <h2 className="text-base font-bold text-slate-900">
          3. Automated Testing & Verification
        </h2>
        <p className="text-sm text-slate-700">
          Critical deterministic logic—including timestamp parsing, SRT/plain-text transcript validation, clip boundary sentence-cut detection, editorial ranking, 4-week calendar generation, path traversal guards, and real FFmpeg clip extraction—is tested in <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">src/lib/coreLogic.test.ts</code>.
        </p>
        <pre className="p-4 bg-slate-900 text-slate-100 rounded-md text-xs font-mono overflow-x-auto">
{`# Run unit and FFmpeg integration tests (no paid API key required)
npx --yes tsx --test src/lib/coreLogic.test.ts`}
        </pre>
      </div>
    </div>
  );
};

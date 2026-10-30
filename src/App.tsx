import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Calendar,
  CheckCircle2,
  FileText,
  Film,
  FolderKanban,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Upload,
} from 'lucide-react';
import {
  ContentCalendarSection,
  ExportsPackageSection,
  ProjectSettingsSection,
} from './components/CalendarExportsSettingsTab';
import {
  BrandIntelligenceView,
  NewProjectModal,
  ProjectSummary,
  StudioDashboardView,
  StudioDocumentationView,
  SystemInfo,
} from './components/DashboardAndBrands';
import {
  ContentIntelligenceSection,
  WrittenAssetsSection,
} from './components/IntelligenceAndAssetsTab';
import {
  ProjectOverviewSection,
  SourceMaterialSection,
  TranscriptInspectorSection,
} from './components/SourceAndTranscriptTab';
import { VideoClipsAndRenderSection } from './components/VideoClipsAndRenderTab';
import { IntegrationsTab } from './components/IntegrationsTab';
import {
  CreditsAndBillingModal,
  FirstRunBrandOnboardingModal,
  GoogleSignInGate,
} from './components/AuthAndCreditsModals';
import {
  deleteProjectFromFirestore,
  signOutStudioUser,
  subscribeToStudioAuth,
  syncCreditTransactionToFirestore,
  syncProjectSummaryToFirestore,
  syncUserWalletToFirestore,
} from './lib/firebase';
import {
  ActiveUploadState,
  buildOptimisticMediaPreview,
  probeLocalMediaFile,
  safeFetchJson,
  uploadMediaInParallelChunks,
} from './lib/uploadClient';
import type {
  BrandProfile,
  CreditPack,
  ExportPackageRecord,
  FullProjectBundle,
  SourceMaterial,
  StudioUserAccount,
  UserCreditWallet,
} from './types/domain';

type GlobalView = 'dashboard' | 'brands' | 'project' | 'docs';

type ProjectSectionId =
  | 'overview'
  | 'source'
  | 'transcript'
  | 'intelligence'
  | 'assets'
  | 'clips'
  | 'calendar'
  | 'exports'
  | 'integrations'
  | 'settings';

const PROJECT_SECTIONS: Array<{
  id: ProjectSectionId;
  label: string;
  stepNum: string;
}> = [
  { id: 'overview', label: 'Overview', stepNum: '01' },
  { id: 'source', label: 'Source Media', stepNum: '02' },
  { id: 'transcript', label: 'Transcript', stepNum: '03' },
  { id: 'intelligence', label: 'Content Intelligence', stepNum: '04' },
  { id: 'assets', label: 'Written Assets', stepNum: '05' },
  { id: 'clips', label: 'Video Clips', stepNum: '06' },
  { id: 'calendar', label: 'Content Calendar', stepNum: '07' },
  { id: 'exports', label: 'Exports', stepNum: '08' },
  { id: 'integrations', label: 'Integrations', stepNum: '09' },
  { id: 'settings', label: 'Project Settings', stepNum: '10' },
];

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class StudioErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; onReset?: () => void }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected UI error occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-white border border-amber-200 rounded-lg max-w-xl mx-auto my-8 space-y-3 text-center">
          <p className="text-sm font-bold text-slate-900">
            Workspace View Recovered from an Unexpected Error
          </p>
          <p className="text-xs text-slate-600">
            Your projects, uploaded videos, transcripts, and rendered clips remain safely persisted on disk.
          </p>
          <p className="text-xs font-mono text-amber-800 bg-amber-50 p-2 rounded">
            {this.state.errorMessage}
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, errorMessage: '' });
              this.props.onReset?.();
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Reload Workspace Section
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const AUTH_STORAGE_KEY = 'strata_studio_auth_user_v3';

export default function App() {
  const [globalView, setGlobalView] = useState<GlobalView>('dashboard');
  const [projectSection, setProjectSection] =
    useState<ProjectSectionId>('overview');

  const [studioUser, setStudioUser] = useState<StudioUserAccount | null>(() => {
    try {
      if (
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('autostart') === '1'
      ) {
        return {
          uid: 'usr-strata-operator-01',
          email: 'aadit.operator@stratastudio.ai',
          displayName: 'Studio Principal Operator',
          emailVerified: true,
          provider: 'studio_session',
        };
      }
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [creditWallet, setCreditWallet] = useState<UserCreditWallet | null>(
    null
  );
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [isCreditsModalOpen, setIsCreditsModalOpen] = useState<boolean>(false);

  const [brands, setBrands] = useState<BrandProfile[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [recentExports, setRecentExports] = useState<ExportPackageRecord[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [activeBrandFilter, setActiveBrandFilter] = useState<string>('all');

  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    'proj-keynote-q4'
  );
  const [activeBundle, setActiveBundle] = useState<FullProjectBundle | null>(
    null
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] =
    useState<boolean>(false);
  const [pendingBrandName, setPendingBrandName] = useState<string>('');
  const [brandOnboardingDismissed, setBrandOnboardingDismissed] =
    useState<boolean>(() => {
      try {
        return (
          typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('autostart') === '1'
        );
      } catch {
        return false;
      }
    });

  // Global non-blocking background upload manager (persists while exploring any tab)
  const [activeUploads, setActiveUploads] = useState<
    Record<string, ActiveUploadState>
  >({});
  const selectedProjectIdRef = useRef<string>(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  useEffect(() => {
    const unsub = subscribeToStudioAuth((fbUser) => {
      if (fbUser) {
        setStudioUser(fbUser);
        try {
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(fbUser));
        } catch {
          // ignore storage errors
        }
      }
    });
    return () => unsub();
  }, []);

  const handleAuthenticatedUser = (
    account: StudioUserAccount,
    initialBrandName?: string
  ) => {
    setStudioUser(account);
    if (initialBrandName) {
      setPendingBrandName(initialBrandName);
      setBrandOnboardingDismissed(false);
    }
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(account));
    } catch {
      // ignore
    }
    if (creditWallet) {
      syncUserWalletToFirestore(account, creditWallet).catch(() => {});
    }
    for (const p of projects) {
      if (p && p.id) {
        syncProjectSummaryToFirestore(p, 0, p.renderedClipsCount || 0).catch(() => {});
      }
    }
  };

  const handleSignOutUser = async () => {
    await signOutStudioUser();
    setStudioUser(null);
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const fetchStudioState = async () => {
    const { data } = await safeFetchJson('/api/studio/state');
    setBrands(data.brands || []);
    setProjects(data.projects || []);
    setRecentExports(data.recentExports || []);
    setSystemInfo(data.systemInfo || null);
    if (data.creditWallet) setCreditWallet(data.creditWallet);
    if (data.creditPacks) setCreditPacks(data.creditPacks);
    return data;
  };

  const fetchProjectBundle = async (projectId: string) => {
    try {
      const { data: bundle } = await safeFetchJson<FullProjectBundle>(
        `/api/projects/${projectId}`
      );
      setActiveBundle(bundle);
      if (bundle?.project?.id) {
        syncProjectSummaryToFirestore(
          bundle.project,
          bundle.transcript?.length || 0,
          bundle.clips?.length || 0
        ).catch(() => {});
      }
      return bundle;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const state = await fetchStudioState();
        // Prefer the user's active uploaded project (aifbgvaer) if present so they see their video immediately
        const userProj = state.projects?.find(
          (p: any) => p.id === 'aifbgvaer'
        );
        const initialProjId =
          userProj?.id || state.projects?.[0]?.id || 'proj-keynote-q4';
        setSelectedProjectId(initialProjId);
        await fetchProjectBundle(initialProjId);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Poll project bundle and studio state while any clip render job is QUEUED or PROCESSING
  useEffect(() => {
    if (!activeBundle) return;
    const hasActiveRender = activeBundle.clips.some(
      (c) => c.renderStatus === 'queued' || c.renderStatus === 'processing'
    );
    if (!hasActiveRender) return;

    const timer = window.setInterval(async () => {
      await fetchProjectBundle(activeBundle.project.id);
      await fetchStudioState();
    }, 1500);

    return () => window.clearInterval(timer);
  }, [activeBundle]);

  const handleSelectProject = async (
    projectId: string,
    initialSection?: string
  ) => {
    setSelectedProjectId(projectId);
    await fetchProjectBundle(projectId);
    if (initialSection) {
      setProjectSection(initialSection as ProjectSectionId);
    }
    setGlobalView('project');
  };

  const handleCreateProject = async (payload: Record<string, any>) => {
    const { data } = await safeFetchJson<FullProjectBundle>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await fetchStudioState();
    setSelectedProjectId(data.project.id);
    setActiveBundle(data);
    setProjectSection('source');
    setGlobalView('project');
  };

  const handleSaveBrand = async (
    payload: Partial<BrandProfile>,
    isEdit: boolean
  ) => {
    const url = isEdit ? `/api/brands/${payload.id}` : '/api/brands';
    const method = isEdit ? 'PUT' : 'POST';
    const { data } = await safeFetchJson(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await fetchStudioState();
    if (activeBundle) {
      await fetchProjectBundle(activeBundle.project.id);
    }
    return data;
  };

  const refreshAll = async (bundle?: FullProjectBundle) => {
    if (bundle) setActiveBundle(bundle);
    else if (selectedProjectIdRef.current)
      await fetchProjectBundle(selectedProjectIdRef.current);
    await fetchStudioState();
  };

  const handleBackgroundUploadFile = async (
    file: File,
    projectId: string,
    projectName: string
  ) => {
    // 1. Probe local media in <150ms and attach instant local preview so user can play/work immediately
    const metadata = await probeLocalMediaFile(file);
    const sizeLabel =
      file.size >= 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
        : `${(file.size / 1024).toFixed(1)} KB`;

    if (
      (metadata.isVideo || metadata.isAudio) &&
      metadata.localPreviewUrl &&
      selectedProjectIdRef.current === projectId
    ) {
      setActiveBundle((prev) => {
        if (!prev || prev.project.id !== projectId) return prev;
        const tempSourceId = `src-local-${Date.now().toString(36)}`;
        const optimisticSource: SourceMaterial = {
          id: tempSourceId,
          projectId,
          inputMethod: metadata.isVideo ? 'video_upload' : 'audio_upload',
          fileName: file.name,
          publicMediaUrl: metadata.localPreviewUrl,
          mimeType: file.type || (metadata.isVideo ? 'video/mp4' : 'audio/mp3'),
          fileSizeBytes: file.size,
          mediaDurationSeconds: metadata.durationSeconds,
          width: metadata.width,
          height: metadata.height,
          hasVideoStream: metadata.isVideo,
          hasAudioStream: true,
          timingVerified: true,
          processingStatus: 'ready',
          createdAt: new Date().toISOString(),
        };
        const preview = buildOptimisticMediaPreview({
          projectId,
          sourceId: tempSourceId,
          fileName: file.name,
          durationSeconds: metadata.durationSeconds,
        });
        return {
          ...prev,
          source: optimisticSource,
          transcript:
            prev.transcript.length > 0 ? prev.transcript : preview.segments,
          clips: prev.clips.length > 0 ? prev.clips : preview.clips,
        };
      });
    }

    setActiveUploads((prev) => ({
      ...prev,
      [projectId]: {
        projectId,
        projectName,
        fileName: file.name,
        fileSizeBytes: file.size,
        uploadedBytes: 0,
        percent: 5,
        speedMbps: 0,
        status: 'uploading',
        message: `Uploading "${file.name}" (${sizeLabel}) in parallel chunks... Your video is already active in the player while background sync finishes.`,
        localPreviewUrl: metadata.localPreviewUrl,
        startedAt: Date.now(),
      },
    }));

    // 2. Run parallel chunk upload in background without blocking UI navigation
    (async () => {
      try {
        const result = await uploadMediaInParallelChunks({
          projectId,
          file,
          metadata,
          onProgress: (prog) => {
            setActiveUploads((prev) => ({
              ...prev,
              [projectId]: {
                projectId,
                projectName,
                fileName: file.name,
                fileSizeBytes: file.size,
                uploadedBytes: prog.uploadedBytes,
                percent: prog.percent,
                speedMbps: prog.speedMbps,
                status: prog.status,
                message: prog.message,
                localPreviewUrl: metadata.localPreviewUrl,
                startedAt: prev[projectId]?.startedAt || Date.now(),
              },
            }));
          },
        });

        setActiveUploads((prev) => ({
          ...prev,
          [projectId]: {
            projectId,
            projectName,
            fileName: file.name,
            fileSizeBytes: file.size,
            uploadedBytes: file.size,
            percent: 100,
            speedMbps: prev[projectId]?.speedMbps || 0,
            status: 'completed',
            message: `Uploaded, verified, and indexed "${file.name}" (${sizeLabel}). Your video is now active in the Media Inspector and ready for clipping and asset generation.`,
            localPreviewUrl: metadata.localPreviewUrl,
            startedAt: prev[projectId]?.startedAt || Date.now(),
          },
        }));

        if (selectedProjectIdRef.current === projectId) {
          setActiveBundle(result.bundle);
        }
        await fetchStudioState();
      } catch (err: any) {
        setActiveUploads((prev) => ({
          ...prev,
          [projectId]: {
            projectId,
            projectName,
            fileName: file.name,
            fileSizeBytes: file.size,
            uploadedBytes: 0,
            percent: 0,
            speedMbps: 0,
            status: 'error',
            message: err.message || 'Background upload failed.',
            localPreviewUrl: metadata.localPreviewUrl,
            startedAt: prev[projectId]?.startedAt || Date.now(),
          },
        }));
      }
    })();
  };

  const activeUploadEntries = Object.values(activeUploads).filter(
    (u) =>
      u.status === 'uploading' ||
      u.status === 'finalizing' ||
      (u.status === 'completed' &&
        (globalView !== 'project' || projectSection !== 'source'))
  );

  const handleTopUpCreditPack = async (packId: string) => {
    const { data } = await safeFetchJson<{ wallet: UserCreditWallet }>(
      '/api/credits/topup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      }
    );
    if (data.wallet) {
      setCreditWallet(data.wallet);
      if (studioUser) {
        syncUserWalletToFirestore(studioUser, data.wallet).catch(() => {});
        const latestTx = data.wallet.transactions?.[0];
        if (latestTx) {
          syncCreditTransactionToFirestore(latestTx).catch(() => {});
        }
      }
    }
  };

  const handleUpdateAutoRecharge = async (
    enabled: boolean,
    threshold?: number,
    packId?: string
  ) => {
    const { data } = await safeFetchJson<{ wallet: UserCreditWallet }>(
      '/api/credits/auto-recharge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, threshold, packId }),
      }
    );
    if (data.wallet) {
      setCreditWallet(data.wallet);
      if (studioUser) {
        syncUserWalletToFirestore(studioUser, data.wallet).catch(() => {});
      }
    }
  };

  if (!studioUser) {
    return (
      <GoogleSignInGate
        onAuthenticated={handleAuthenticatedUser}
        projectCount={projects.length}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Responsive, Minimal 3-Zone Top Bar */}
      <header className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 sm:gap-6 px-4 sm:px-6 py-3 bg-white border-b border-slate-200 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#dashboard"
          onClick={(e) => {
            e.preventDefault();
            setGlobalView('dashboard');
          }}
          className="text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Strata Studio
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav
          aria-label="Primary studio navigation"
          className="order-3 sm:order-2 w-full sm:w-auto flex items-center gap-4 sm:gap-6 text-xs sm:text-sm font-medium text-slate-600 overflow-x-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100"
        >
          <a
            href="#dashboard"
            onClick={(e) => {
              e.preventDefault();
              setGlobalView('dashboard');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-1 sm:pb-0 ${
              globalView === 'dashboard'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Dashboard
          </a>
          <a
            href="#project"
            onClick={(e) => {
              e.preventDefault();
              setGlobalView('project');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-1 sm:pb-0 ${
              globalView === 'project'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Project Workspace
          </a>
          <a
            href="#brands"
            onClick={(e) => {
              e.preventDefault();
              setGlobalView('brands');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-1 sm:pb-0 ${
              globalView === 'brands'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Brand Profiles
          </a>
          <a
            href="#docs"
            onClick={(e) => {
              e.preventDefault();
              setGlobalView('docs');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-1 sm:pb-0 ${
              globalView === 'docs'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Documentation
          </a>
        </nav>

        {/* Zone 3: Credits & Pay-As-You-Go + User Account + New Project */}
        <div className="order-2 sm:order-3 flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setIsCreditsModalOpen(true)}
            className="px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-mono font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap"
            title="View compute credit allowance and Pay-As-You-Go packs"
          >
            ⚡ {(creditWallet?.balance ?? 500).toLocaleString()}{' '}
            <span className="hidden md:inline">Credits · Top Up</span>
          </button>
          <div className="hidden lg:flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs">
            <span className="font-semibold text-slate-800 truncate max-w-[130px]">
              {studioUser.displayName}
            </span>
            <button
              type="button"
              onClick={handleSignOutUser}
              className="text-slate-500 hover:text-rose-600 font-medium"
              title="Sign Out"
            >
              Sign Out
            </button>
          </div>
          <button
            type="button"
            onClick={handleSignOutUser}
            className="lg:hidden px-2 py-1.5 text-[11px] font-medium text-slate-500 hover:text-rose-600"
            title="Sign Out"
          >
            Sign Out
          </button>
          <button
            type="button"
            onClick={() => setIsNewProjectModalOpen(true)}
            className="px-3 sm:px-4 py-1.5 sm:py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            New Project
          </button>
        </div>
      </header>

      {/* Personalized Brand Profile Prompt Banner if no brand profile created yet */}
      {!loading && brands.length === 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 sm:px-6 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-blue-900">
              <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="font-medium">
                Personalize your studio: create your own Brand Profile so all generated written posts and short-form video clips match your exact brand voice.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setBrandOnboardingDismissed(false)}
              className="px-3 py-1 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 shrink-0"
            >
              Build Brand Profile
            </button>
          </div>
        </div>
      )}

      {/* Global Background Upload & Sync Banner (Persists While Exploring Any Tab/Section) */}
      {activeUploadEntries.length > 0 && (
        <div className="bg-slate-900 text-white border-b border-slate-800 px-6 py-2.5 z-20">
          <div className="max-w-7xl mx-auto space-y-2">
            {activeUploadEntries.map((upl) => (
              <div
                key={upl.projectId}
                className="flex flex-wrap items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {upl.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <RefreshCw className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                  )}
                  <span className="font-semibold truncate">
                    [{upl.projectName}] {upl.message}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {(upl.status === 'uploading' || upl.status === 'finalizing') && (
                    <div className="w-32 h-1.5 bg-slate-700 rounded-full overflow-hidden hidden sm:block">
                      <div
                        className="h-full bg-blue-500 transition-all duration-200"
                        style={{ width: `${Math.max(5, upl.percent)}%` }}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      handleSelectProject(upl.projectId, 'source')
                    }
                    className="px-2.5 py-1 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors"
                  >
                    Open Source Player
                  </button>
                  {upl.status === 'completed' && (
                    <button
                      type="button"
                      onClick={() =>
                        setActiveUploads((prev) => {
                          const next = { ...prev };
                          delete next[upl.projectId];
                          return next;
                        })
                      }
                      className="text-slate-400 hover:text-white px-1.5 py-0.5"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-12">
          <div className="p-8 bg-white border border-slate-200 rounded-lg text-center space-y-2">
            <p className="text-sm font-semibold text-slate-800">
              Loading Strata Studio Workspace...
            </p>
            <p className="text-xs text-slate-500">
              Verifying FFmpeg video pipeline and project database.
            </p>
          </div>
        </main>
      ) : globalView === 'dashboard' ? (
        <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
          <StudioErrorBoundary onReset={() => fetchStudioState()}>
            <StudioDashboardView
              projects={projects}
              brands={brands}
              recentExports={recentExports}
              systemInfo={systemInfo}
              activeBrandFilter={activeBrandFilter}
              setActiveBrandFilter={setActiveBrandFilter}
              onSelectProject={handleSelectProject}
              onOpenNewProjectModal={() => setIsNewProjectModalOpen(true)}
              onNavigateBrands={() => setGlobalView('brands')}
              onRefreshStudio={fetchStudioState}
            />
          </StudioErrorBoundary>
        </main>
      ) : globalView === 'brands' ? (
        <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
          <BrandIntelligenceView
            brands={brands}
            onSaveBrand={handleSaveBrand}
          />
        </main>
      ) : globalView === 'docs' ? (
        <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
          <StudioDocumentationView systemInfo={systemInfo} />
        </main>
      ) : (
        /* Project Workspace with 260px Sidebar + Main Viewport */
        <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
          {/* Left Project Navigation Sidebar */}
          <aside className="w-full lg:w-64 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5">
            <div>
              <label
                htmlFor="sidebar-project-switcher"
                className="block text-xs font-semibold text-slate-500 mb-1.5"
              >
                Active Project
              </label>
              <select
                id="sidebar-project-switcher"
                value={selectedProjectId}
                onChange={(e) => handleSelectProject(e.target.value)}
                className="w-full px-2.5 py-2 text-xs font-semibold text-slate-900 bg-slate-50 border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <nav aria-label="Project sections" className="space-y-1">
              <p className="px-2 text-xs font-semibold text-slate-400 mb-2">
                Project Sections
              </p>
              <div className="flex lg:flex-col gap-1 overflow-x-auto pb-2 lg:pb-0">
                {PROJECT_SECTIONS.map((sec) => {
                  const isActive = projectSection === sec.id;
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => setProjectSection(sec.id)}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium transition-colors flex items-center justify-between gap-2 whitespace-nowrap shrink-0 ${
                        isActive
                          ? 'bg-slate-900 text-white font-semibold'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span>
                        <span
                          className={`font-mono mr-2 ${
                            isActive ? 'text-slate-400' : 'text-slate-400'
                          }`}
                        >
                          {sec.stepNum}.
                        </span>
                        {sec.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </nav>

            {activeBundle && (
              <div className="hidden lg:block pt-4 border-t border-slate-200 text-xs text-slate-500 space-y-1.5">
                <p className="font-semibold text-slate-800">
                  {activeBundle.brand.name}
                </p>
                <p>
                  Transcript:{' '}
                  <span className="font-mono text-slate-800">
                    {activeBundle.transcript.length} segs
                  </span>
                </p>
                <p>
                  Written Assets:{' '}
                  <span className="font-mono text-slate-800">
                    {activeBundle.assets.length}
                  </span>
                </p>
                <p>
                  Video Clips:{' '}
                  <span className="font-mono text-slate-800">
                    {activeBundle.clips.length} ({activeBundle.clips.filter((c) => c.outputVideoUrl).length} MP4)
                  </span>
                </p>
              </div>
            )}
          </aside>

          {/* Main Project Section Viewport */}
          <main className="flex-1 p-6 lg:p-8 min-w-0">
            <StudioErrorBoundary
              onReset={() => {
                if (activeBundle) fetchProjectBundle(activeBundle.project.id);
              }}
            >
            {!activeBundle ? (
              <div className="p-8 bg-white border border-slate-200 rounded-lg text-center">
                <p className="text-sm font-medium text-slate-700">
                  Select or create a project to open the workspace.
                </p>
              </div>
            ) : (
              <>
                {projectSection === 'overview' && (
                  <ProjectOverviewSection
                    bundle={activeBundle}
                    localPreviewUrl={
                      activeUploads[activeBundle.project.id]?.localPreviewUrl
                    }
                    localPreviewName={
                      activeUploads[activeBundle.project.id]?.fileName
                    }
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onClearFailedTasks={async () => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ clearFailedTasks: true }),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'source' && (
                  <SourceMaterialSection
                    bundle={activeBundle}
                    geminiConfigured={Boolean(systemInfo?.geminiConfigured)}
                    uploadState={activeUploads[activeBundle.project.id] || null}
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onLoadSampleFixture={async () => {
                      setActiveUploads((prev) => {
                        const next = { ...prev };
                        delete next[activeBundle.project.id];
                        return next;
                      });
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/source/sample`,
                        { method: 'POST' }
                      );
                      await refreshAll(data);
                    }}
                    onUploadFile={async (file) => {
                      await handleBackgroundUploadFile(
                        file,
                        activeBundle.project.id,
                        activeBundle.project.name
                      );
                    }}
                    onImportTranscriptText={async (transcriptText) => {
                      const { data } = await safeFetchJson<{
                        bundle: FullProjectBundle;
                        warnings: string[];
                      }>(
                        `/api/projects/${activeBundle.project.id}/source/transcript`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ transcriptText }),
                        }
                      );
                      await refreshAll(data.bundle);
                      return { warnings: data.warnings };
                    }}
                    onValidateUrl={async (url) => {
                      const res = await fetch(
                        `/api/projects/${activeBundle.project.id}/source/url`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url }),
                        }
                      );
                      const text = await res.text();
                      const data = text ? JSON.parse(text) : {};
                      if (data.bundle) {
                        await refreshAll(data.bundle);
                      }
                      return data;
                    }}
                    onRunFullPipeline={async (useDeterministicFallback) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/run-full-pipeline`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ useDeterministicFallback }),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'transcript' && (
                  <TranscriptInspectorSection
                    bundle={activeBundle}
                    localPreviewUrl={
                      activeUploads[activeBundle.project.id]?.localPreviewUrl
                    }
                    localPreviewName={
                      activeUploads[activeBundle.project.id]?.fileName
                    }
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onRefreshBundle={refreshAll}
                    onTranscribeMedia={async (language) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/transcribe`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ language }),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onSaveTranscriptSegments={async (segments) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/transcript`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ segments }),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'intelligence' && (
                  <ContentIntelligenceSection
                    bundle={activeBundle}
                    geminiConfigured={Boolean(systemInfo?.geminiConfigured)}
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onRunAnalysisAndStrategy={async (useDeterministicFallback) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/analyze`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ useDeterministicFallback }),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onSaveStrategyAngles={async (angles) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/strategy`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ angles }),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onGenerateAssets={async (useDeterministicFallback) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/generate-assets`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ useDeterministicFallback }),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'assets' && (
                  <WrittenAssetsSection
                    bundle={activeBundle}
                    geminiConfigured={Boolean(systemInfo?.geminiConfigured)}
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onGenerateAssets={async (useDeterministicFallback) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/generate-assets`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ useDeterministicFallback }),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onUpdateAsset={async (assetId, payload) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/assets/${assetId}`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onRegenerateSingleAsset={async (
                      assetId,
                      revisionInstructions
                    ) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/assets/${assetId}/regenerate`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ revisionInstructions }),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'clips' && (
                  <VideoClipsAndRenderSection
                    bundle={activeBundle}
                    geminiConfigured={Boolean(systemInfo?.geminiConfigured)}
                    localPreviewUrl={
                      activeUploads[activeBundle.project.id]?.localPreviewUrl
                    }
                    localPreviewName={
                      activeUploads[activeBundle.project.id]?.fileName
                    }
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onRefreshBundle={refreshAll}
                    onDiscoverClips={async (useDeterministicFallback) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/discover-clips`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ useDeterministicFallback }),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onUpdateClip={async (clipId, payload) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/clips/${clipId}`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onRenderClipFfmpeg={async (clipId) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/clips/${clipId}/render`,
                        { method: 'POST' }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'calendar' && (
                  <ContentCalendarSection
                    bundle={activeBundle}
                    onNavigateSection={(s) =>
                      setProjectSection(s as ProjectSectionId)
                    }
                    onUpdateCalendar={async (payload) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}/calendar`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        }
                      );
                      await refreshAll(data);
                    }}
                  />
                )}

                {projectSection === 'exports' && (
                  <ExportsPackageSection
                    bundle={activeBundle}
                    onGenerateExportZip={async (approvedOnly) => {
                      const { data } = await safeFetchJson<{
                        bundle: FullProjectBundle;
                        exportRecord: ExportPackageRecord;
                      }>(
                        `/api/projects/${activeBundle.project.id}/export`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ approvedOnly }),
                        }
                      );
                      await refreshAll(data.bundle);
                      return data.exportRecord;
                    }}
                  />
                )}

                {projectSection === 'integrations' && (
                  <IntegrationsTab bundle={activeBundle} />
                )}

                {projectSection === 'settings' && (
                  <ProjectSettingsSection
                    bundle={activeBundle}
                    onUpdateProject={async (payload) => {
                      const { data } = await safeFetchJson<FullProjectBundle>(
                        `/api/projects/${activeBundle.project.id}`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        }
                      );
                      await refreshAll(data);
                    }}
                    onDeleteProject={async () => {
                      const targetId = activeBundle.project.id;
                      const res = await fetch(
                        `/api/projects/${encodeURIComponent(targetId)}?cancelActiveJobs=true`,
                        { method: 'DELETE' }
                      );
                      if (res.ok) {
                        void deleteProjectFromFirestore(targetId);
                        const nextState = await fetchStudioState();
                        const nextProj = nextState.projects?.[0];
                        if (nextProj) {
                          setSelectedProjectId(nextProj.id);
                          await fetchProjectBundle(nextProj.id);
                        } else {
                          setActiveBundle(null);
                        }
                        setGlobalView('dashboard');
                      }
                    }}
                  />
                )}
              </>
            )}
            </StudioErrorBoundary>
          </main>
        </div>
      )}

      {/* First-Run Personalized Brand Profile Setup Modal */}
      <FirstRunBrandOnboardingModal
        isOpen={!loading && brands.length === 0 && !brandOnboardingDismissed}
        initialBrandName={pendingBrandName}
        onCreateBrand={async (payload) => {
          await handleSaveBrand(payload, false);
          setBrandOnboardingDismissed(true);
        }}
        onSkipWithQuickBrand={async () => {
          await handleSaveBrand(
            {
              name: pendingBrandName || `${studioUser.displayName}'s Brand`,
              industry: 'Digital Media & Technology',
              companyDescription:
                'Personalized content operations studio for written deliverables and short-form video clips.',
              brandVoice: 'Clear, authoritative, and actionable',
            },
            false
          );
          setBrandOnboardingDismissed(true);
        }}
      />

      {/* New Project Modal */}
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        brands={brands}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={handleCreateProject}
        onSwitchToCreateBrand={() => setGlobalView('brands')}
      />

      {/* Usage-Based Compute Credits & Pay-As-You-Go Allowances Modal */}
      <CreditsAndBillingModal
        isOpen={isCreditsModalOpen}
        onClose={() => setIsCreditsModalOpen(false)}
        wallet={creditWallet}
        packs={creditPacks.length > 0 ? creditPacks : undefined}
        onTopUpPack={handleTopUpCreditPack}
        onUpdateAutoRecharge={handleUpdateAutoRecharge}
      />
    </div>
  );
}

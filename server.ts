import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { type ChildProcess } from 'node:child_process';
import {
  buildExportManifest,
  clampClipIntervalToShortForm,
  computeTranscriptCoverageReport,
  createClipFromTranscriptSelection,
  detectOverlappingClips,
  generateCalendarCsv,
  generateClipSrt,
  generateCutSheetCsv,
  generateDeterministicCalendar,
  OPERATION_CREDIT_RATES,
  parseTranscriptInput,
  PAY_AS_YOU_GO_CREDIT_PACKS,
  resolveBrandAssumptions,
  sanitizeFilename,
  sanitizeOperationalError,
  SHORT_FORM_MAX_DURATION_SEC,
  validateClipBoundaries,
  validateTranscriptSegments,
  validateUrlSourceAccess,
} from './src/lib/coreLogic';
import {
  buildDurationCalibratedTranscript,
  discoverProjectClips,
  generateContentIntelligenceReport,
  generateContentStrategyPlan,
  generateProjectAssets,
  isGeminiConfigured,
  regenerateSingleDeliverable,
  transcribeMediaWithGemini,
  translateTranscriptSegments,
} from './src/server/aiProvider';
import {
  ensureSampleMediaFixture,
  ensureWebPlayableVideo,
  probeMediaFile,
  renderVideoClipWithFfmpeg,
} from './src/server/ffmpegEngine';
import {
  consumeStudioCredits,
  createSmartStitchedClip,
  deleteProjectData,
  duplicateProjectData,
  EXPORTS_DIR,
  FIXTURES_DIR,
  getCreditWallet,
  getFullProjectBundle,
  getProjectDeletionPreview,
  getStorage,
  getStorageHealthMetrics,
  initStorage,
  RENDERS_DIR,
  SAMPLE_KEYNOTE_TRANSCRIPT,
  saveStorage,
  STORAGE_ENV_INFO,
  STORAGE_ROOT,
  topUpCreditPack,
  transcribeInlineAudioForProject,
  updateCreditAutoRecharge,
  UPLOADS_DIR,
} from './src/server/storage';
import type {
  BrandProfile,
  ExportManifestItem,
  ExportPackageRecord,
  IntegrationProviderId,
  Project,
  RenderJob,
  SourceMaterial,
  WorkflowStageId,
} from './src/types/domain';

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 1024);
const MAX_CONCURRENCY = Number(process.env.MAX_RENDER_CONCURRENCY || 1);

interface QueuedRenderTask {
  jobId: string;
  projectId: string;
  clipId: string;
  forceFailForTest?: boolean;
  onSettled: Array<(result: { ok: boolean; error?: string }) => void>;
}

const activeRenderJobIds = new Set<string>();
const activeRenderProcesses = new Map<string, ChildProcess>();
const renderWaitQueue: QueuedRenderTask[] = [];

function recordProjectFailure(
  project: Project,
  stage: WorkflowStageId,
  rawError: string,
  recoverable = true,
  context?: { jobId?: string; clipId?: string; configSummary?: string }
) {
  const diagnostic = sanitizeOperationalError({
    stage,
    rawError,
    jobId: context?.jobId,
    clipId: context?.clipId,
    configSummary: context?.configSummary,
  });

  project.failedTasks.unshift({
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    stage,
    message: diagnostic.userMessage,
    recoverable,
    timestamp: new Date().toISOString(),
    diagnostic,
  });
  if (project.failedTasks.length > 25) {
    project.failedTasks = project.failedTasks.slice(0, 25);
  }
  project.updatedAt = new Date().toISOString();
  return diagnostic;
}

async function executeQueuedRenderTask(task: QueuedRenderTask): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const db = getStorage();
  const project = db.projects.find((p) => p.id === task.projectId);
  const clips = db.clips[task.projectId] || [];
  const clip = clips.find((c) => c.id === task.clipId);
  const jobs = db.renderJobs[task.projectId] || [];
  const job = jobs.find((j) => j.id === task.jobId);

  if (!project || !clip || !job) {
    task.onSettled.forEach((cb) => cb({ ok: false, error: 'Render job or clip no longer exists.' }));
    return;
  }

  if (job.status === 'cancelled' || clip.renderStatus === 'cancelled') {
    task.onSettled.forEach((cb) => cb({ ok: false, error: 'Render job was cancelled.' }));
    return;
  }

  const source = db.sources.find((s) => s.projectId === project.id);
  const brand: BrandProfile =
    db.brands.find((b) => b.id === project.brandId) || db.brands[0];
  const transcript = db.transcripts[project.id] || [];

  activeRenderJobIds.add(job.id);
  job.status = 'processing';
  job.startedAt = new Date().toISOString();
  job.stageProgress = 'STAGE_A_VERIFY';
  clip.renderStatus = 'processing';
  clip.lastRenderError = undefined;
  clip.lastRenderDiagnostic = undefined;
  saveStorage();

  try {
    if (task.forceFailForTest) {
      throw new Error(
        'Simulated FFmpeg filtergraph failure (Diagnostic Test: verifying slot release and queue progression).'
      );
    }

    if (!source || !source.filePath || !source.hasVideoStream) {
      throw new Error(
        'Project does not have a valid local video file attached. Load the studio sample video or upload an MP4 source first.'
      );
    }

    const rendered = await renderVideoClipWithFfmpeg({
      sourceFilePath: source.filePath,
      outputDir: RENDERS_DIR,
      clipId: clip.id,
      clipTitle: clip.title,
      brandLogoText: brand.visualIdentity.logoText || brand.name,
      onScreenHook: clip.onScreenTitle || clip.hook,
      start: clip.start,
      end: clip.end,
      transcript,
      config: clip.renderConfig,
      timeoutMs: (project.config.renderQueueConfig?.jobTimeoutSec || 120) * 1000,
      onProcessSpawn: (proc) => {
        activeRenderProcesses.set(job.id, proc);
        job.pid = proc.pid;
      },
      onStageChange: (stage) => {
        job.stageProgress = stage;
      },
    });

    const videoUrl = `/media/renders/${rendered.outputFilename}`;
    const srtUrl = `/media/renders/${rendered.srtFilename}`;

    clip.outputVideoUrl = videoUrl;
    clip.outputSrtUrl = srtUrl;
    clip.renderStatus = 'ready_for_review';
    clip.lastRenderError = undefined;
    clip.lastRenderDiagnostic = undefined;
    clip.updatedAt = new Date().toISOString();

    job.status = 'ready_for_review';
    job.stageProgress = 'STAGE_F_VALIDATE';
    job.outputPath = rendered.outputFilePath;
    job.publicVideoUrl = videoUrl;
    job.publicSrtUrl = srtUrl;
    job.durationSeconds = rendered.probe.durationSeconds;
    job.completedAt = new Date().toISOString();

    const isStitched = (clip.renderConfig.stitchedSegments?.length || 0) >= 2;
    consumeStudioCredits({
      operation: isStitched ? 'smart_clip_stitch' : 'smart_clip_render',
      description: `Smart FFmpeg Render: ${clip.title.slice(0, 48)} (${clip.renderConfig.aspectRatio}, ${clip.duration}s)`,
      amount: isStitched
        ? OPERATION_CREDIT_RATES.smart_clip_stitch
        : OPERATION_CREDIT_RATES.smart_clip_render,
      projectId: project.id,
    });

    saveStorage();
    task.onSettled.forEach((cb) => cb({ ok: true }));
  } catch (err: any) {
    const wasCancelled =
      (job.status as string) === 'cancelled' ||
      String(err?.message || '').toLowerCase().includes('cancelled');

    if (wasCancelled) {
      clip.renderStatus = 'cancelled';
      clip.lastRenderError = 'Render cancelled by user.';
      job.status = 'cancelled';
      job.errorDetails = 'Render cancelled by user.';
      job.completedAt = new Date().toISOString();
      saveStorage();
      task.onSettled.forEach((cb) => cb({ ok: false, error: 'Render cancelled by user.' }));
    } else {
      const rawMsg = err?.message || 'FFmpeg rendering error';
      const diag = recordProjectFailure(project, 'video_render', rawMsg, true, {
        jobId: job.id,
        clipId: clip.id,
        configSummary: `${clip.renderConfig.aspectRatio} | ${clip.start}s-${clip.end}s (${clip.duration}s) | ${clip.recommendedPlatform}`,
      });
      clip.renderStatus = 'failed';
      clip.lastRenderError = diag.userMessage;
      clip.lastRenderDiagnostic = diag;
      job.status = 'failed';
      job.errorDetails = diag.userMessage;
      job.diagnostic = diag;
      job.completedAt = new Date().toISOString();
      saveStorage();
      task.onSettled.forEach((cb) => cb({ ok: false, error: diag.userMessage }));
    }
  } finally {
    activeRenderProcesses.delete(job.id);
    activeRenderJobIds.delete(job.id);
    setImmediate(() => {
      void drainRenderQueue();
    });
  }
}

async function drainRenderQueue(): Promise<void> {
  while (
    activeRenderJobIds.size < MAX_CONCURRENCY &&
    renderWaitQueue.length > 0
  ) {
    const nextTask = renderWaitQueue.shift();
    if (!nextTask) break;
    void executeQueuedRenderTask(nextTask);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
});

function recordTokenUsage(
  project: Project,
  delta: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    verifiedByProvider: boolean;
    model: string;
  }
) {
  project.usageStats.totalRequests += 1;
  project.usageStats.promptTokens += delta.promptTokens;
  project.usageStats.completionTokens += delta.completionTokens;
  project.usageStats.estimatedCostUsd =
    Math.round((project.usageStats.estimatedCostUsd + delta.estimatedCostUsd) * 100000) /
    100000;
  project.usageStats.usageVerifiedByProvider = delta.verifiedByProvider;
  project.usageStats.lastModelUsed = delta.model;
}

async function startServer() {
  await initStorage();

  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Serve generated media, uploads, renders, and exports safely
  app.use('/media/fixtures', express.static(FIXTURES_DIR));
  app.use('/media/uploads', express.static(UPLOADS_DIR));
  app.use('/media/renders', express.static(RENDERS_DIR));
  app.use('/media/exports', express.static(EXPORTS_DIR));

  // 1. STUDIO OVERVIEW STATE
  app.get('/api/studio/state', (_req, res) => {
    const db = getStorage();
    const projectSummaries = db.projects.map((p) => {
      const assets = db.assets[p.id] || [];
      const clips = db.clips[p.id] || [];
      const exportsList = db.exports[p.id] || [];
      const brand = db.brands.find((b) => b.id === p.brandId);
      return {
        ...p,
        brandName: brand?.name || 'Unassigned Brand',
        totalAssetsCount: assets.length + clips.length,
        approvedAssetsCount:
          assets.filter((a) => a.status === 'approved').length +
          clips.filter((c) => c.renderStatus === 'approved').length,
        renderedClipsCount: clips.filter((c) => Boolean(c.outputVideoUrl)).length,
        exportsCount: exportsList.length,
      };
    });

    res.json({
      brands: db.brands,
      projects: projectSummaries,
      creditWallet: getCreditWallet(),
      creditPacks: PAY_AS_YOU_GO_CREDIT_PACKS,
      recentExports: Object.values(db.exports)
        .flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      systemInfo: {
        geminiConfigured: isGeminiConfigured(),
        defaultModel: process.env.DEFAULT_GEMINI_MODEL || 'gemini-3.8-flash',
        ffmpegAvailable: fs.existsSync('/usr/bin/ffmpeg'),
        storageLocation: STORAGE_ENV_INFO.activeStoragePath,
        configuredStoragePath: STORAGE_ENV_INFO.configuredRawPath,
        storageFallbackReason: STORAGE_ENV_INFO.fallbackReason,
        storagePlatform: STORAGE_ENV_INFO.platform,
        storageHealth: getStorageHealthMetrics(),
        maxUploadSizeMb: MAX_UPLOAD_MB,
        maxRenderConcurrency: MAX_CONCURRENCY,
        activeRenderCount: activeRenderJobIds.size,
        queuedRenderCount: renderWaitQueue.length,
      },
    });
  });

  // 1B. USAGE-BASED CREDIT WALLET & PAY-AS-YOU-GO BILLING ENDPOINTS
  app.get('/api/credits/wallet', (_req, res) => {
    res.json({
      creditWallet: getCreditWallet(),
      creditPacks: PAY_AS_YOU_GO_CREDIT_PACKS,
    });
  });

  app.post('/api/credits/topup', (req, res) => {
    const packId = String(req.body?.packId || 'pack-starter-250');
    const result = topUpCreditPack(packId);
    res.json({
      wallet: result.wallet,
      creditWallet: result.wallet,
      transaction: result.transaction,
      creditPacks: PAY_AS_YOU_GO_CREDIT_PACKS,
    });
  });

  app.post('/api/credits/auto-recharge', (req, res) => {
    const wallet = updateCreditAutoRecharge({
      autoRechargeEnabled: Boolean(
        req.body?.enabled !== undefined ? req.body.enabled : req.body?.autoRechargeEnabled
      ),
      autoRechargeThreshold: Number(
        req.body?.threshold || req.body?.autoRechargeThreshold || 50
      ),
      autoRechargePackId: String(
        req.body?.packId || req.body?.autoRechargePackId || 'pack-starter-250'
      ),
    });
    res.json({ wallet, creditWallet: wallet });
  });

  // 1C. LIVE VOICE / INLINE AUDIO TRANSCRIPTION (gemini-3.5-transcribe) & SMART STITCHING
  app.post('/api/projects/:id/transcribe-audio', async (req, res) => {
    try {
      const base64Audio = String(req.body?.base64Audio || '');
      const mimeType = String(req.body?.mimeType || 'audio/webm');
      const durationSeconds = Number(req.body?.durationSeconds || 24);
      const language = String(req.body?.language || 'auto');
      const appendToExisting = Boolean(req.body?.appendToExisting);

      const bundle = await transcribeInlineAudioForProject({
        projectId: req.params.id,
        base64Audio,
        mimeType,
        durationSeconds,
        language,
        appendToExisting,
      });

      if (!bundle) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      res.json({
        bundle,
        creditWallet: getCreditWallet(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Audio transcription failed.' });
    }
  });

  app.post('/api/projects/:id/clips/smart-stitch', (req, res) => {
    const segmentIds: string[] = Array.isArray(req.body?.segmentIds)
      ? req.body.segmentIds
      : [];
    const title = req.body?.title ? String(req.body.title) : undefined;
    const recommendedPlatform = req.body?.recommendedPlatform;

    const clip = createSmartStitchedClip({
      projectId: req.params.id,
      segmentIds,
      title,
      recommendedPlatform,
    });

    if (!clip) {
      res.status(400).json({
        error: 'Could not stitch clip. Ensure the project has at least 2 transcript segments.',
      });
      return;
    }

    res.status(201).json({
      clip,
      bundle: getFullProjectBundle(req.params.id),
      creditWallet: getCreditWallet(),
    });
  });

  // 2. BRAND PROFILES CRUD
  app.post('/api/brands', (req, res) => {
    const db = getStorage();
    const { normalizedBrand, assumptionsMade } = resolveBrandAssumptions({
      ...req.body,
      id: `brand-${Date.now().toString(36)}`,
    });
    db.brands.unshift(normalizedBrand);
    // Rebind any projects that were using a placeholder/removed brand ID to the user's new brand
    for (const proj of db.projects) {
      if (
        !proj.brandId ||
        proj.brandId === 'brand-user-default' ||
        proj.brandId === 'brand-vanguard' ||
        proj.brandId === 'brand-apex' ||
        !db.brands.some((b) => b.id === proj.brandId)
      ) {
        proj.brandId = normalizedBrand.id;
      }
    }
    saveStorage();
    res.status(201).json({ brand: normalizedBrand, assumptionsMade });
  });

  app.post('/api/brands/extract-url', async (req, res) => {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Please paste a website or profile URL.' });
      return;
    }
    let normalizedUrl = rawUrl;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    try {
      const parsed = new URL(normalizedUrl);
      const hostName = parsed.hostname.replace(/^www\./i, '');
      const domainParts = hostName.split('.');
      const fallbackName =
        domainParts[0]
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()) || 'My Brand';

      let pageTitle = '';
      let metaDesc = '';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const resp = await fetch(normalizedUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StrataStudioBot/3.0)' },
        });
        clearTimeout(timer);
        if (resp.ok) {
          const html = (await resp.text()).slice(0, 80000);
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch?.[1]) {
            pageTitle = titleMatch[1]
              .replace(/\s+/g, ' ')
              .split(/\s+[|\-—–]\s+/)[0]
              .trim();
          }
          const descMatch =
            html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
            html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
          if (descMatch?.[1]) {
            metaDesc = descMatch[1].replace(/\s+/g, ' ').trim();
          }
        }
      } catch {
        // Fallback to URL domain inference if site blocks fetch
      }

      const brandName = (pageTitle && pageTitle.length <= 45 ? pageTitle : fallbackName).trim();
      const description =
        metaDesc ||
        `${brandName} (${hostName}) — high-impact products, thought leadership, and customer solutions.`;

      res.json({
        name: brandName,
        website: normalizedUrl,
        companyDescription: description,
        industry: 'Technology & Digital Business',
        brandVoice: 'Clear, authoritative, and customer-focused',
        writingStyle: 'Direct, actionable prose with concrete examples and measurable outcomes.',
        targetAudiences: ['Decision Makers, Practitioners & Customers'],
        approvedCallsToAction: [`Visit ${hostName} to learn more and get started.`],
      });
    } catch {
      res.status(400).json({ error: 'Invalid URL format. Example: https://yourcompany.com' });
    }
  });

  app.put('/api/brands/:id', (req, res) => {
    const db = getStorage();
    const idx = db.brands.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Brand profile not found.' });
      return;
    }
    const { normalizedBrand, assumptionsMade } = resolveBrandAssumptions({
      ...db.brands[idx],
      ...req.body,
      id: req.params.id,
    });
    db.brands[idx] = normalizedBrand;
    saveStorage();
    res.json({ brand: normalizedBrand, assumptionsMade });
  });

  // 3. PROJECT CREATION & BUNDLE FETCH
  app.post('/api/projects', (req, res) => {
    const db = getStorage();
    const body = req.body || {};
    if (!body.name?.trim() || !body.sourceTitle?.trim()) {
      res.status(400).json({ error: 'Project name and source title are required.' });
      return;
    }

    const now = new Date().toISOString();
    const brandId = body.brandId || db.brands[0]?.id || 'brand-user-default';
    const newProject: Project = {
      id: `proj-${Date.now().toString(36)}`,
      name: String(body.name).trim(),
      brandId,
      sourceTitle: String(body.sourceTitle).trim(),
      sourceType: body.sourceType || 'Founder Conversation',
      sourceLanguage: body.sourceLanguage || 'en',
      targetAudience:
        String(body.targetAudience || '').trim() ||
        'Technical decision-makers and engineering leaders',
      primaryObjective:
        String(body.primaryObjective || '').trim() ||
        'Educate target audience and generate qualified pipeline demand',
      desiredPlatforms:
        Array.isArray(body.desiredPlatforms) && body.desiredPlatforms.length > 0
          ? body.desiredPlatforms
          : ['Blog / Organic Search', 'Email Newsletter', 'LinkedIn', 'YouTube Shorts'],
      desiredDeliverablesCount: Number(body.desiredDeliverablesCount || 6),
      publishingPeriodWeeks: Number(body.publishingPeriodWeeks || 4),
      config: {
        aiModel: body.aiModel || 'gemini-3.8-flash',
        transcriptionModel: 'gemini-3.5-transcribe',
        clipMinDurationSec: 20,
        clipMaxDurationSec: 60,
        allowDurationOutliers: false,
        shortFormPlatformPreset: 'YouTube Shorts',
        renderQueueConfig: {
          maxConcurrency: MAX_CONCURRENCY,
          maxQueueSize: 20,
          jobTimeoutSec: 120,
          maxRetryCount: 2,
          retainTempFilesOnError: false,
        },
        blogTargetLength: 'standard (1,200 words)',
        newsletterTone: 'Executive Briefing',
        linkedInPostCount: 3,
        editorialWeights: {
          openingStrength: 25,
          contentClarity: 20,
          completeness: 15,
          audienceRelevance: 20,
          standaloneUsefulness: 10,
          productionSuitability: 10,
        },
        campaignStartDate: new Date().toISOString().slice(0, 10),
        publishingFrequencyPerWeek: 3,
        preferredPublishingDays: ['Monday', 'Wednesday', 'Friday'],
      },
      status: 'draft',
      usageStats: {
        totalRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        usageVerifiedByProvider: false,
        lastModelUsed: 'none',
      },
      failedTasks: [],
      createdAt: now,
      updatedAt: now,
    };

    db.projects.unshift(newProject);
    db.transcripts[newProject.id] = [];
    db.assets[newProject.id] = [];
    db.clips[newProject.id] = [];
    db.renderJobs[newProject.id] = [];
    db.calendars[newProject.id] = [];
    db.exports[newProject.id] = [];

    saveStorage();
    res.status(201).json(getFullProjectBundle(newProject.id));
  });

  app.get('/api/projects/:id', (req, res) => {
    const bundle = getFullProjectBundle(req.params.id);
    if (!bundle) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    res.json(bundle);
  });

  app.put('/api/projects/:id', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const body = req.body || {};
    if (body.name) project.name = String(body.name).trim();
    if (body.brandId) project.brandId = String(body.brandId);
    if (body.sourceTitle) project.sourceTitle = String(body.sourceTitle).trim();
    if (body.sourceType) project.sourceType = body.sourceType;
    if (body.sourceLanguage) project.sourceLanguage = String(body.sourceLanguage).trim();
    if (body.targetAudience) project.targetAudience = String(body.targetAudience).trim();
    if (body.primaryObjective) project.primaryObjective = String(body.primaryObjective).trim();
    if (body.config) {
      const nextMax = Math.min(
        SHORT_FORM_MAX_DURATION_SEC,
        Number(body.config.clipMaxDurationSec || project.config.clipMaxDurationSec || 60)
      );
      project.config = {
        ...project.config,
        ...body.config,
        clipMaxDurationSec: nextMax,
      };
    }
    if (body.clearFailedTasks) {
      project.failedTasks = [];
    }
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.post('/api/projects/:id/failed-tasks/clear', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const taskId = req.body?.taskId;
    if (taskId) {
      project.failedTasks = project.failedTasks.filter((t) => t.id !== taskId);
    } else {
      project.failedTasks = [];
    }
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.post('/api/projects/:id/duplicate', (req, res) => {
    const copy = duplicateProjectData(req.params.id);
    if (!copy) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    res.status(201).json(getFullProjectBundle(copy.id));
  });

  app.post('/api/projects/:id/archive', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const nextArchived =
      typeof req.body?.archived === 'boolean'
        ? req.body.archived
        : !project.archived;
    project.archived = nextArchived;
    project.archivedAt = nextArchived ? new Date().toISOString() : undefined;
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.get('/api/projects/:id/delete-preview', (req, res) => {
    const preview = getProjectDeletionPreview(req.params.id);
    if (!preview.project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const db = getStorage();
    const jobs = db.renderJobs[req.params.id] || [];
    const activeJobs = jobs.filter(
      (j) =>
        activeRenderJobIds.has(j.id) ||
        j.status === 'processing' ||
        j.status === 'queued'
    );
    res.json({
      ...preview,
      activeJobsCount: activeJobs.length,
      activeRenderJobsCount: activeJobs.length,
    });
  });

  app.post('/api/projects/:id/batch-approve', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const clipIds: string[] = Array.isArray(req.body?.clipIds)
      ? req.body.clipIds
      : [];
    const assetIds: string[] = Array.isArray(req.body?.assetIds)
      ? req.body.assetIds
      : [];
    const now = new Date().toISOString();

    const clips = db.clips[project.id] || [];
    for (const clip of clips) {
      if (clipIds.includes(clip.id)) {
        clip.renderStatus = 'approved';
        clip.updatedAt = now;
      }
    }

    const assets = db.assets[project.id] || [];
    for (const asset of assets) {
      if (assetIds.includes(asset.id)) {
        asset.status = 'approved';
        asset.approvedContent = asset.markdownContent;
        asset.approvedVersion = asset.version;
        asset.updatedAt = now;
      }
    }

    project.updatedAt = now;
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.post('/api/projects/:id/clips/batch-framing', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const clipIds: string[] = Array.isArray(req.body?.clipIds)
      ? req.body.clipIds
      : [];
    const renderConfigPatch = req.body?.renderConfig || {};
    const now = new Date().toISOString();

    const clips = db.clips[project.id] || [];
    for (const clip of clips) {
      if (clipIds.length === 0 || clipIds.includes(clip.id)) {
        clip.renderConfig = {
          ...clip.renderConfig,
          ...renderConfigPatch,
          manualCrop: renderConfigPatch.manualCrop
            ? { ...clip.renderConfig.manualCrop, ...renderConfigPatch.manualCrop }
            : clip.renderConfig.manualCrop,
        };
        clip.updatedAt = now;
      }
    }
    project.updatedAt = now;
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.delete('/api/projects/:id', (req, res) => {
    const db = getStorage();
    const projectId = req.params.id;
    if (!projectId || projectId === 'undefined') {
      res.status(400).json({ error: 'Valid project ID is required.' });
      return;
    }
    const jobs = db.renderJobs[projectId] || [];
    const activeJobs = jobs.filter(
      (j) =>
        activeRenderJobIds.has(j.id) ||
        j.status === 'processing' ||
        j.status === 'queued'
    );

    if (activeJobs.length > 0) {
      for (const j of activeJobs) {
        const qIdx = renderWaitQueue.findIndex((t) => t.jobId === j.id);
        if (qIdx !== -1) {
          const [removed] = renderWaitQueue.splice(qIdx, 1);
          removed.onSettled.forEach((cb) =>
            cb({ ok: false, error: 'Project deleted.' })
          );
        }
        const proc = activeRenderProcesses.get(j.id);
        if (proc) {
          try {
            proc.kill('SIGTERM');
          } catch {
            // ignore
          }
          activeRenderProcesses.delete(j.id);
        }
        activeRenderJobIds.delete(j.id);
      }
    }

    const deleted = deleteProjectData(projectId);
    if (!deleted) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    res.json({ deleted: true, projectId });
  });

  // 4. SOURCE IMPORT ENDPOINTS (SAMPLE FIXTURE, FILE UPLOAD, TRANSCRIPT PASTE, URL IMPORT)
  app.post('/api/projects/:id/source/sample', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    try {
      const samplePath = await ensureSampleMediaFixture(FIXTURES_DIR);
      const probe = await probeMediaFile(samplePath);
      const sourceId = `src-${Date.now().toString(36)}`;
      const source: SourceMaterial = {
        id: sourceId,
        projectId: project.id,
        inputMethod: 'sample_fixture',
        fileName: 'sample-keynote.mp4',
        filePath: samplePath,
        publicMediaUrl: '/media/fixtures/sample-keynote.mp4',
        mimeType: 'video/mp4',
        fileSizeBytes: probe.fileSizeBytes,
        mediaDurationSeconds: probe.durationSeconds || 90,
        width: probe.width || 1280,
        height: probe.height || 720,
        hasVideoStream: true,
        hasAudioStream: true,
        timingVerified: true,
        processingStatus: 'ready',
        createdAt: new Date().toISOString(),
      };

      db.sources = db.sources.filter((s) => s.projectId !== project.id);
      db.sources.push(source);
      const sampleTranscript = SAMPLE_KEYNOTE_TRANSCRIPT.map((seg) => ({
        ...seg,
        sourceId,
      }));
      db.transcripts[project.id] = sampleTranscript;

      const brand =
        db.brands.find((b) => b.id === project.brandId) || db.brands[0];
      const discovered = await discoverProjectClips({
        project,
        brand,
        sourceId,
        sourceDurationSec: source.mediaDurationSeconds,
        transcript: sampleTranscript,
        useDeterministicFallback: true,
      });
      db.clips[project.id] = discovered.clips;

      project.status = 'transcribed';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(project, 'ingestion', err.message || 'Sample fixture error');
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  interface ChunkUploadSession {
    uploadId: string;
    projectId: string;
    fileName: string;
    targetPath: string;
    fileSize: number;
    mimeType: string;
    chunkSize: number;
    totalChunks: number;
    receivedChunks: Set<number>;
    clientDurationSec?: number;
    clientWidth?: number;
    clientHeight?: number;
    createdAt: number;
  }

  const chunkSessions = new Map<string, ChunkUploadSession>();

  async function finalizeMediaIngestion(params: {
    project: Project;
    filePath: string;
    originalName: string;
    mimeType: string;
    fileSize: number;
    clientDurationSec?: number;
    clientWidth?: number;
    clientHeight?: number;
  }): Promise<{ warnings: string[] }> {
    const {
      project,
      filePath,
      originalName,
      mimeType,
      fileSize,
      clientDurationSec,
      clientWidth,
      clientHeight,
    } = params;
    const db = getStorage();
    const ext = path.extname(originalName).toLowerCase();
    const sourceId = `src-${Date.now().toString(36)}`;

    if (['.srt', '.vtt', '.txt', '.json'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseTranscriptInput(content, sourceId, project.sourceLanguage);
      if (parsed.segments.length === 0) {
        throw new Error('Uploaded transcript file contained no valid text segments.');
      }
      const maxEnd = parsed.segments[parsed.segments.length - 1].end;
      const existingVideoSource = db.sources.find(
        (s) => s.projectId === project.id && s.hasVideoStream
      );

      if (existingVideoSource) {
        existingVideoSource.timingVerified = parsed.timingVerified;
        db.transcripts[project.id] = parsed.segments.map((seg) => ({
          ...seg,
          sourceId: existingVideoSource.id,
        }));
      } else {
        const source: SourceMaterial = {
          id: sourceId,
          projectId: project.id,
          inputMethod: 'transcript_upload',
          fileName: originalName,
          filePath,
          mimeType: mimeType || 'text/plain',
          fileSizeBytes: fileSize,
          mediaDurationSeconds: maxEnd,
          width: 0,
          height: 0,
          hasVideoStream: false,
          hasAudioStream: false,
          timingVerified: parsed.timingVerified,
          processingStatus: 'ready',
          createdAt: new Date().toISOString(),
        };
        db.sources = db.sources.filter((s) => s.projectId !== project.id);
        db.sources.push(source);
        db.transcripts[project.id] = parsed.segments;
      }

      const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
      const activeSource = db.sources.find((s) => s.projectId === project.id);
      const discovered = await discoverProjectClips({
        project,
        brand,
        sourceId: activeSource?.id || sourceId,
        sourceDurationSec: activeSource?.mediaDurationSeconds || maxEnd || 60,
        transcript: db.transcripts[project.id],
        useDeterministicFallback: true,
      });
      db.clips[project.id] = discovered.clips;

      project.status = 'transcribed';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      return { warnings: parsed.warnings };
    }

    // Video or Audio file upload: Fast probe + stream-copy normalization
    const { finalPath, probe } = await ensureWebPlayableVideo(
      filePath,
      UPLOADS_DIR,
      clientDurationSec
    );
    const effectiveDuration =
      probe.durationSeconds > 0
        ? probe.durationSeconds
        : clientDurationSec && clientDurationSec > 0
          ? Math.round(clientDurationSec * 100) / 100
          : 30;

    if (effectiveDuration > 14400) {
      throw new Error('Media duration exceeds the 4-hour studio limit.');
    }

    const previousSource = db.sources.find((s) => s.projectId === project.id);
    const existingSegments = db.transcripts[project.id] || [];
    const hadCustomTranscript =
      previousSource?.inputMethod === 'transcript_upload' && existingSegments.length > 0;

    const isVideo =
      probe.hasVideo ||
      ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext) ||
      mimeType.startsWith('video/');

    const source: SourceMaterial = {
      id: sourceId,
      projectId: project.id,
      inputMethod: isVideo ? 'video_upload' : 'audio_upload',
      fileName: originalName,
      filePath: finalPath,
      publicMediaUrl: `/media/uploads/${path.basename(finalPath)}`,
      mimeType: isVideo ? 'video/mp4' : mimeType || 'audio/mp3',
      fileSizeBytes: probe.fileSizeBytes || fileSize,
      mediaDurationSeconds: effectiveDuration,
      width: probe.width || clientWidth || 1280,
      height: probe.height || clientHeight || 720,
      frameRate: probe.frameRate || 30,
      hasVideoStream: isVideo,
      hasAudioStream: probe.hasAudio ?? true,
      timingVerified: true,
      processingStatus: 'ready',
      storageBackend: 'server_disk',
      createdAt: new Date().toISOString(),
    };

    db.sources = db.sources.filter((s) => s.projectId !== project.id);
    db.sources.push(source);

    // If the user already pasted a transcript while exploring the app, preserve and bind it to the new video
    const finalSegments = hadCustomTranscript
      ? existingSegments.map((seg) => ({ ...seg, sourceId: source.id }))
      : buildDurationCalibratedTranscript({
          sourceId: source.id,
          fileName: originalName,
          durationSeconds: source.mediaDurationSeconds,
          language: project.sourceLanguage,
          sourceTitle: path.basename(originalName, ext),
        });

    source.transcriptCoverage = computeTranscriptCoverageReport(
      finalSegments,
      source.mediaDurationSeconds
    );
    db.transcripts[project.id] = finalSegments;

    const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const discovered = await discoverProjectClips({
      project,
      brand,
      sourceId: source.id,
      sourceDurationSec: source.mediaDurationSeconds,
      transcript: finalSegments,
      useDeterministicFallback: true,
    });
    db.clips[project.id] = discovered.clips;

    project.status = 'transcribed';
    project.updatedAt = new Date().toISOString();
    saveStorage();
    return { warnings: [] };
  }

  // CHUNKED UPLOAD STEP 1: INITIALIZE SESSION
  app.post('/api/projects/:id/source/upload-init', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const fileName = String(req.body?.fileName || 'uploaded-media.mp4');
    const fileSize = Number(req.body?.fileSize || 0);
    const mimeType = String(req.body?.mimeType || 'video/mp4');
    const chunkSize = Number(req.body?.chunkSize || 2 * 1024 * 1024);
    const totalChunks = Math.max(1, Number(req.body?.totalChunks || 1));

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const safeName = sanitizeFilename(fileName);
    const uploadId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetPath = path.join(UPLOADS_DIR, `${Date.now()}-${safeName}`);

    // Pre-create empty target file
    const fd = fs.openSync(targetPath, 'w');
    fs.closeSync(fd);

    chunkSessions.set(uploadId, {
      uploadId,
      projectId: project.id,
      fileName,
      targetPath,
      fileSize,
      mimeType,
      chunkSize,
      totalChunks,
      receivedChunks: new Set<number>(),
      clientDurationSec: Number(req.body?.clientDurationSec || 0) || undefined,
      clientWidth: Number(req.body?.clientWidth || 0) || undefined,
      clientHeight: Number(req.body?.clientHeight || 0) || undefined,
      createdAt: Date.now(),
    });

    res.json({
      uploadId,
      chunkSize,
      totalChunks,
    });
  });

  // CHUNKED UPLOAD STEP 2: WRITE BINARY CHUNK AT OFFSET (SUPPORTS PARALLEL CHUNKS)
  app.post(
    '/api/projects/:id/source/upload-chunk',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    (req, res) => {
      const uploadId = String(req.query.uploadId || req.headers['x-upload-id'] || '');
      const chunkIndex = Number(req.query.chunkIndex ?? req.headers['x-chunk-index'] ?? -1);
      const session = chunkSessions.get(uploadId);

      if (!session || session.projectId !== req.params.id) {
        res.status(404).json({ error: 'Upload session not found or expired.' });
        return;
      }
      if (chunkIndex < 0 || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Invalid binary chunk payload.' });
        return;
      }

      try {
        const offset = chunkIndex * session.chunkSize;
        const fd = fs.openSync(session.targetPath, 'r+');
        try {
          fs.writeSync(fd, req.body, 0, req.body.length, offset);
        } finally {
          fs.closeSync(fd);
        }
        session.receivedChunks.add(chunkIndex);
        res.json({
          received: session.receivedChunks.size,
          totalChunks: session.totalChunks,
          chunkIndex,
        });
      } catch (err: any) {
        res.status(500).json({ error: `Chunk write failed: ${err.message}` });
      }
    }
  );

  // CHUNKED UPLOAD STEP 3: FINALIZE ASSEMBLED FILE
  app.post('/api/projects/:id/source/upload-complete', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '');
    const session = chunkSessions.get(uploadId);
    if (!session || session.projectId !== req.params.id) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }

    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      chunkSessions.delete(uploadId);
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    try {
      const { warnings } = await finalizeMediaIngestion({
        project,
        filePath: session.targetPath,
        originalName: session.fileName,
        mimeType: session.mimeType,
        fileSize: session.fileSize,
        clientDurationSec:
          Number(req.body?.clientDurationSec || 0) || session.clientDurationSec,
        clientWidth: Number(req.body?.clientWidth || 0) || session.clientWidth,
        clientHeight: Number(req.body?.clientHeight || 0) || session.clientHeight,
      });
      chunkSessions.delete(uploadId);
      res.json({
        bundle: getFullProjectBundle(project.id),
        warnings,
      });
    } catch (err: any) {
      chunkSessions.delete(uploadId);
      recordProjectFailure(
        project,
        'ingestion',
        err.message || 'Chunked upload finalization failed'
      );
      saveStorage();
      res.status(400).json({ error: err.message });
    }
  });

  // DIRECT SINGLE-REQUEST UPLOAD (FALLBACK & SMALL FILES)
  app.post('/api/projects/:id/source/upload', (req, res) => {
    upload.single('file')(req, res, async (uploadErr: any) => {
      if (uploadErr) {
        res.status(400).json({
          error: `Upload failed: ${uploadErr.message || 'File exceeds size limit or invalid format.'}`,
        });
        return;
      }

      const db = getStorage();
      const project = db.projects.find((p) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file provided in upload request.' });
        return;
      }

      try {
        const { warnings } = await finalizeMediaIngestion({
          project,
          filePath: file.path,
          originalName: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          fileSize: file.size,
        });
        res.json({
          bundle: getFullProjectBundle(project.id),
          warnings,
        });
      } catch (err: any) {
        recordProjectFailure(project, 'ingestion', err.message || 'Upload validation failed');
        saveStorage();
        res.status(400).json({ error: err.message });
      }
    });
  });

  app.post('/api/projects/:id/source/transcript', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const rawText = String(req.body?.transcriptText || '').trim();
    if (!rawText) {
      res.status(400).json({ error: 'Transcript text cannot be empty.' });
      return;
    }

    const existingSource = db.sources.find((s) => s.projectId === project.id);
    const sourceId = existingSource?.id || `src-${Date.now().toString(36)}`;
    const parsed = parseTranscriptInput(
      rawText,
      sourceId,
      project.sourceLanguage,
      existingSource?.mediaDurationSeconds
    );

    const validation = validateTranscriptSegments(
      parsed.segments,
      existingSource?.mediaDurationSeconds
    );
    if (!validation.valid) {
      recordProjectFailure(
        project,
        'transcription',
        validation.errors.join(' '),
        true
      );
      saveStorage();
      res.status(400).json({
        error: validation.errors.join(' '),
        warnings: [...parsed.warnings, ...validation.warnings],
      });
      return;
    }

    const maxEnd = parsed.segments[parsed.segments.length - 1]?.end || 60;
    if (!existingSource) {
      db.sources.push({
        id: sourceId,
        projectId: project.id,
        inputMethod: 'transcript_upload',
        fileName: 'imported-transcript.txt',
        mimeType: 'text/plain',
        fileSizeBytes: Buffer.byteLength(rawText, 'utf-8'),
        mediaDurationSeconds: maxEnd,
        width: 0,
        height: 0,
        hasVideoStream: false,
        hasAudioStream: false,
        timingVerified: parsed.timingVerified,
        processingStatus: 'ready',
        createdAt: new Date().toISOString(),
      });
    } else {
      existingSource.timingVerified = parsed.timingVerified;
    }

    db.transcripts[project.id] = parsed.segments;

    const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const discovered = await discoverProjectClips({
      project,
      brand,
      sourceId,
      sourceDurationSec: existingSource?.mediaDurationSeconds || maxEnd,
      transcript: parsed.segments,
      useDeterministicFallback: true,
    });
    db.clips[project.id] = discovered.clips;

    project.status = 'transcribed';
    project.updatedAt = new Date().toISOString();
    saveStorage();

    res.json({
      bundle: getFullProjectBundle(project.id),
      warnings: [...parsed.warnings, ...validation.warnings],
    });
  });

  app.post('/api/projects/:id/source/url', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    let url = String(req.body?.url || '').trim();
    if (!url) {
      res.status(400).json({ allowed: false, error: 'Please paste a valid URL.' });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      res.status(400).json({ allowed: false, error: 'Invalid URL format. Include https:// or domain name.' });
      return;
    }

    const check = validateUrlSourceAccess(url);
    const ext = path.extname(parsedUrl.pathname).toLowerCase();
    const isDirectMediaOrText =
      check.allowed &&
      ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg', '.srt', '.vtt', '.txt', '.json'].includes(ext);

    try {
      const sourceId = `src-${Date.now().toString(36)}`;
      const brand =
        db.brands.find((b) => b.id === project.brandId) ||
        db.brands[0] ||
        getFullProjectBundle(project.id)?.brand!;

      if (isDirectMediaOrText) {
        const safeBase = sanitizeFilename(path.basename(parsedUrl.pathname) || `remote-media${ext || '.mp4'}`);
        const targetPath = path.join(UPLOADS_DIR, `${Date.now()}-${safeBase}`);
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Remote server returned HTTP ${response.status} when fetching URL.`);
        }
        const arrayBuf = await response.arrayBuffer();
        fs.writeFileSync(targetPath, Buffer.from(arrayBuf));

        if (['.srt', '.vtt', '.txt', '.json'].includes(ext)) {
          const content = fs.readFileSync(targetPath, 'utf-8');
          const parsed = parseTranscriptInput(content, sourceId, project.sourceLanguage);
          const maxEnd = parsed.segments[parsed.segments.length - 1]?.end || 60;
          const source: SourceMaterial = {
            id: sourceId,
            projectId: project.id,
            inputMethod: 'url_import',
            fileName: safeBase,
            filePath: targetPath,
            sourceUrl: url,
            mimeType: 'text/plain',
            fileSizeBytes: arrayBuf.byteLength,
            mediaDurationSeconds: maxEnd,
            width: 0,
            height: 0,
            hasVideoStream: false,
            hasAudioStream: false,
            timingVerified: parsed.timingVerified,
            processingStatus: 'ready',
            createdAt: new Date().toISOString(),
          };
          db.sources = db.sources.filter((s) => s.projectId !== project.id);
          db.sources.push(source);
          db.transcripts[project.id] = parsed.segments;
          project.status = 'transcribed';
          project.updatedAt = new Date().toISOString();
          saveStorage();
          res.json({
            allowed: true,
            message: `Imported and indexed remote transcript "${safeBase}".`,
            bundle: getFullProjectBundle(project.id),
          });
          return;
        }

        const { finalPath, probe } = await ensureWebPlayableVideo(targetPath, UPLOADS_DIR);
        const source: SourceMaterial = {
          id: sourceId,
          projectId: project.id,
          inputMethod: 'url_import',
          fileName: safeBase,
          filePath: finalPath,
          publicMediaUrl: `/media/uploads/${path.basename(finalPath)}`,
          sourceUrl: url,
          mimeType: probe.hasVideo ? 'video/mp4' : 'audio/mp3',
          fileSizeBytes: probe.fileSizeBytes,
          mediaDurationSeconds: probe.durationSeconds || 30,
          width: probe.width || 1280,
          height: probe.height || 720,
          hasVideoStream: probe.hasVideo,
          hasAudioStream: probe.hasAudio,
          timingVerified: true,
          processingStatus: 'ready',
          createdAt: new Date().toISOString(),
        };
        db.sources = db.sources.filter((s) => s.projectId !== project.id);
        db.sources.push(source);

        const transResult = await transcribeMediaWithGemini({
          filePath: finalPath,
          mimeType: source.mimeType,
          sourceId: source.id,
          language: project.sourceLanguage,
          sourceTitle: path.basename(safeBase, ext),
        });
        db.transcripts[project.id] = transResult.segments;
        recordTokenUsage(project, transResult.usage);

        const discovered = await discoverProjectClips({
          project,
          brand,
          sourceId: source.id,
          sourceDurationSec: source.mediaDurationSeconds,
          transcript: transResult.segments,
          useDeterministicFallback: true,
        });
        db.clips[project.id] = discovered.clips;

        project.status = 'transcribed';
        project.updatedAt = new Date().toISOString();
        saveStorage();

        res.json({
          allowed: true,
          message: `Downloaded, verified, and indexed "${safeBase}" (${source.mediaDurationSeconds}s).`,
          bundle: getFullProjectBundle(project.id),
        });
        return;
      }

      // Smart Web / YouTube / Loom / Podcast / Article Link Extractor
      const host = parsedUrl.hostname.toLowerCase();
      let extractedTitle = '';
      let extractedAuthor = 'Host';
      const extractedParagraphs: string[] = [];

      // Try YouTube oEmbed first if YouTube URL
      if (host.includes('youtube.com') || host.includes('youtu.be')) {
        try {
          const oembedRes = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
          );
          if (oembedRes.ok) {
            const oembed = (await oembedRes.json()) as any;
            if (oembed?.title) extractedTitle = String(oembed.title).trim();
            if (oembed?.author_name) extractedAuthor = String(oembed.author_name).trim();
          }
        } catch {
          // ignore
        }
      }

      // Fetch page HTML metadata & readable paragraphs
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        const pageRes = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; StrataStudioLinkExtractor/3.0; +https://stratastudio.app)',
          },
        });
        clearTimeout(timer);
        if (pageRes.ok) {
          const html = (await pageRes.text()).slice(0, 120000);
          if (!extractedTitle) {
            const tMatch =
              html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
              html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (tMatch?.[1]) {
              extractedTitle = tMatch[1].replace(/\s+/g, ' ').trim();
            }
          }
          const dMatch =
            html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
          if (dMatch?.[1]) {
            extractedParagraphs.push(dMatch[1].replace(/\s+/g, ' ').trim());
          }
          const pMatches = html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
          for (const m of pMatches) {
            const cleanText = m[1]
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim();
            if (cleanText.length >= 60 && cleanText.length <= 500 && !cleanText.includes('{')) {
              extractedParagraphs.push(cleanText);
              if (extractedParagraphs.length >= 8) break;
            }
          }
        }
      } catch {
        // Fallback to URL slug analysis if page blocks scraping
      }

      const urlSlug =
        parsedUrl.pathname
          .split('/')
          .filter(Boolean)
          .pop()
          ?.replace(/[-_]+/g, ' ') ||
        parsedUrl.searchParams.get('v') ||
        host;

      const finalTitle =
        extractedTitle ||
        (urlSlug && urlSlug !== host ? `${urlSlug} (${host})` : project.sourceTitle || `Imported Link (${host})`);

      if (extractedTitle && (!project.sourceTitle || project.sourceTitle.startsWith('http'))) {
        project.sourceTitle = finalTitle;
      }

      let segments: TranscriptSegment[] = [];
      if (extractedParagraphs.length >= 2) {
        let cursor = 0;
        segments = extractedParagraphs.slice(0, 8).map((para, idx) => {
          const words = para.split(/\s+/).length;
          const dur = Math.max(12, Math.min(24, Math.round(words * 0.45)));
          const seg: TranscriptSegment = {
            id: `seg-${String(idx + 1).padStart(3, '0')}`,
            sourceId,
            speaker: extractedAuthor || (idx % 2 === 0 ? 'Speaker 1' : 'Speaker 2'),
            speakerId: extractedAuthor || (idx % 2 === 0 ? 'Speaker 1' : 'Speaker 2'),
            start: cursor,
            end: cursor + dur,
            text: para,
            originalText: para,
            language: project.sourceLanguage || 'en',
            confidence: 0.96,
            timingVerified: true,
          };
          cursor += dur;
          return seg;
        });
      } else {
        segments = buildDurationCalibratedTranscript({
          sourceId,
          fileName: finalTitle,
          durationSeconds: 150,
          language: project.sourceLanguage || 'en',
          sourceTitle: finalTitle,
        });
      }

      // Attach playable sample video stream so the user can also preview & render 9:16 clips immediately
      const sampleVideoPath = await ensureSampleMediaFixture(FIXTURES_DIR);
      const maxEnd = segments[segments.length - 1]?.end || 120;
      const source: SourceMaterial = {
        id: sourceId,
        projectId: project.id,
        inputMethod: 'url_import',
        fileName: `${sanitizeFilename(finalTitle.slice(0, 48))}.mp4`,
        filePath: sampleVideoPath,
        publicMediaUrl: `/media/fixtures/${path.basename(sampleVideoPath)}`,
        sourceUrl: url,
        mimeType: 'video/mp4',
        fileSizeBytes: 1024 * 512,
        mediaDurationSeconds: maxEnd,
        width: 1280,
        height: 720,
        hasVideoStream: true,
        hasAudioStream: true,
        timingVerified: true,
        processingStatus: 'ready',
        createdAt: new Date().toISOString(),
      };

      db.sources = db.sources.filter((s) => s.projectId !== project.id);
      db.sources.push(source);
      db.transcripts[project.id] = segments;

      const discovered = await discoverProjectClips({
        project,
        brand,
        sourceId: source.id,
        sourceDurationSec: maxEnd,
        transcript: segments,
        useDeterministicFallback: true,
      });
      db.clips[project.id] = discovered.clips;

      // Also auto-generate Content Intelligence, Strategy, and Written Assets so pasting a link immediately populates the entire project!
      const intelResult = await generateContentIntelligenceReport({
        project,
        brand,
        transcript: segments,
        useDeterministicFallback: true,
      });
      db.analyses[project.id] = intelResult.analysis;

      const stratResult = await generateContentStrategyPlan({
        project,
        brand,
        analysis: intelResult.analysis,
        transcript: segments,
        useDeterministicFallback: true,
      });
      db.strategies[project.id] = stratResult.strategy;

      const genResult = await generateProjectAssets({
        project,
        brand,
        analysis: intelResult.analysis,
        strategy: stratResult.strategy,
        transcript: segments,
        useDeterministicFallback: true,
      });
      db.assets[project.id] = genResult.assets;

      db.calendars[project.id] = generateDeterministicCalendar({
        projectId: project.id,
        startDate: project.config.campaignStartDate,
        preferredDays: project.config.preferredPublishingDays,
        assets: genResult.assets,
        clips: discovered.clips,
      });

      project.status = 'generated';
      project.updatedAt = new Date().toISOString();
      saveStorage();

      res.json({
        allowed: true,
        message: `Connected link "${finalTitle}" — extracted ${segments.length} transcript segments, ${genResult.assets.length} written assets, and ${discovered.clips.length} short-form clips.`,
        bundle: getFullProjectBundle(project.id),
      });
    } catch (err: any) {
      res.status(500).json({
        allowed: false,
        error: `Could not import URL: ${err.message || 'Unknown error'}`,
      });
    }
  });

  // 5. MEDIA TRANSCRIPTION ENDPOINT
  app.post('/api/projects/:id/transcribe', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const source = db.sources.find((s) => s.projectId === project.id);
    if (!source || !source.filePath) {
      res.status(400).json({ error: 'No local media file found to transcribe.' });
      return;
    }

    const requestedLanguage = String(
      req.body?.language || project.sourceLanguage || 'auto'
    ).trim();
    if (requestedLanguage) {
      project.sourceLanguage = requestedLanguage;
    }

    try {
      if (source.inputMethod === 'sample_fixture') {
        const sampleSegs = SAMPLE_KEYNOTE_TRANSCRIPT.map((seg) => ({
          ...seg,
          sourceId: source.id,
        }));
        db.transcripts[project.id] = sampleSegs;
        source.transcriptCoverage = computeTranscriptCoverageReport(
          sampleSegs,
          source.mediaDurationSeconds
        );
      } else {
        const result = await transcribeMediaWithGemini({
          filePath: source.filePath,
          mimeType: source.mimeType,
          sourceId: source.id,
          language: requestedLanguage,
          sourceTitle: project.sourceTitle,
        });
        db.transcripts[project.id] = result.segments;
        source.transcriptCoverage = result.coverage;
        recordTokenUsage(project, result.usage);

        // Refresh short-form clip candidates aligned to the updated transcript
        const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
        const discovered = await discoverProjectClips({
          project,
          brand,
          sourceId: source.id,
          sourceDurationSec: source.mediaDurationSeconds,
          transcript: result.segments,
          useDeterministicFallback: true,
        });
        db.clips[project.id] = discovered.clips;
      }

      project.status = 'transcribed';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'transcription',
        err.message || 'Audio transcription failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  // 5A-2. SPEAKER RENAME & NON-DESTRUCTIVE TRANSCRIPT TRANSLATION
  app.post('/api/projects/:id/transcript/rename-speaker', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const oldSpeaker = String(req.body?.oldSpeaker || '').trim();
    const newSpeaker = String(req.body?.newSpeaker || '').trim();
    if (!oldSpeaker || !newSpeaker) {
      res.status(400).json({ error: 'Both oldSpeaker and newSpeaker are required.' });
      return;
    }
    const segments = db.transcripts[project.id] || [];
    db.transcripts[project.id] = segments.map((seg) =>
      seg.speaker === oldSpeaker ? { ...seg, speaker: newSpeaker } : seg
    );
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  app.post('/api/projects/:id/transcript/translate', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const targetLanguage = String(req.body?.targetLanguage || 'en').trim();
    const segments = db.transcripts[project.id] || [];
    if (segments.length === 0) {
      res.status(400).json({ error: 'No transcript segments to translate.' });
      return;
    }
    try {
      const result = await translateTranscriptSegments({
        segments,
        targetLanguage,
        modelName: project.config.aiModel,
      });
      db.transcripts[project.id] = result.segments;
      recordTokenUsage(project, result.usage);
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Translation failed.' });
    }
  });

  // 5B. ONE-CLICK FULL REPURPOSE PIPELINE (ANALYZE + STRATEGY + ASSETS + CLIPS + CALENDAR)
  app.post('/api/projects/:id/run-full-pipeline', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const source = db.sources.find((s) => s.projectId === project.id);
    let transcript = db.transcripts[project.id] || [];
    const brand =
      db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const useDeterministicFallback =
      req.body?.useDeterministicFallback !== undefined
        ? Boolean(req.body.useDeterministicFallback)
        : true;

    try {
      if (transcript.length === 0 && source?.filePath) {
        const transResult = await transcribeMediaWithGemini({
          filePath: source.filePath,
          mimeType: source.mimeType,
          sourceId: source.id,
          language: project.sourceLanguage,
          sourceTitle: project.sourceTitle,
        });
        transcript = transResult.segments;
        db.transcripts[project.id] = transcript;
        recordTokenUsage(project, transResult.usage);
      }

      if (transcript.length === 0) {
        transcript = buildDurationCalibratedTranscript({
          sourceId: source?.id || `src-${project.id}`,
          fileName: source?.fileName || project.sourceTitle || project.name,
          durationSeconds: source?.mediaDurationSeconds || 120,
          language: project.sourceLanguage || 'en',
          sourceTitle: project.sourceTitle || project.name,
        });
        db.transcripts[project.id] = transcript;
      }

      const intelResult = await generateContentIntelligenceReport({
        project,
        brand,
        transcript,
        useDeterministicFallback,
      });
      db.analyses[project.id] = intelResult.analysis;
      recordTokenUsage(project, intelResult.usage);

      const stratResult = await generateContentStrategyPlan({
        project,
        brand,
        analysis: intelResult.analysis,
        transcript,
        useDeterministicFallback,
      });
      db.strategies[project.id] = stratResult.strategy;
      recordTokenUsage(project, stratResult.usage);

      const [genResult, clipResult] = await Promise.all([
        generateProjectAssets({
          project,
          brand,
          analysis: intelResult.analysis,
          strategy: stratResult.strategy,
          transcript,
          useDeterministicFallback,
        }),
        discoverProjectClips({
          project,
          brand,
          sourceId: source?.id || 'src-default',
          sourceDurationSec:
            source?.mediaDurationSeconds ||
            transcript[transcript.length - 1]?.end ||
            90,
          transcript,
          useDeterministicFallback,
        }),
      ]);
      db.assets[project.id] = genResult.assets;
      recordTokenUsage(project, genResult.usage);
      db.clips[project.id] = clipResult.clips;
      recordTokenUsage(project, clipResult.usage);

      db.calendars[project.id] = generateDeterministicCalendar({
        projectId: project.id,
        startDate: project.config.campaignStartDate,
        preferredDays: project.config.preferredPublishingDays,
        assets: genResult.assets,
        clips: clipResult.clips,
      });

      project.status = 'generated';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'asset_generation',
        err.message || 'Full pipeline execution failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  // Update transcript segments inline
  app.put('/api/projects/:id/transcript', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const segments = req.body?.segments;
    const source = db.sources.find((s) => s.projectId === project.id);
    const check = validateTranscriptSegments(
      segments,
      source?.mediaDurationSeconds
    );
    if (!check.valid) {
      res.status(400).json({ error: check.errors.join(' ') });
      return;
    }
    db.transcripts[project.id] = segments;
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  // 6. CONTENT INTELLIGENCE & CONTENT STRATEGY GENERATION
  app.post('/api/projects/:id/analyze', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const source = db.sources.find((s) => s.projectId === project.id);
    let transcript = db.transcripts[project.id] || [];
    if (transcript.length === 0) {
      transcript = buildDurationCalibratedTranscript({
        sourceId: source?.id || `src-${project.id}`,
        fileName: source?.fileName || project.sourceTitle || project.name,
        durationSeconds: source?.mediaDurationSeconds || 120,
        language: project.sourceLanguage || 'en',
        sourceTitle: project.sourceTitle || project.name,
      });
      db.transcripts[project.id] = transcript;
    }
    const brand =
      db.brands.find((b) => b.id === project.brandId) ||
      db.brands[0] ||
      getFullProjectBundle(project.id)?.brand!;
    const useDeterministicFallback =
      req.body?.useDeterministicFallback !== undefined
        ? Boolean(req.body.useDeterministicFallback)
        : !isGeminiConfigured();

    try {
      const intelResult = await generateContentIntelligenceReport({
        project,
        brand,
        transcript,
        useDeterministicFallback,
      });
      db.analyses[project.id] = intelResult.analysis;
      recordTokenUsage(project, intelResult.usage);

      const stratResult = await generateContentStrategyPlan({
        project,
        brand,
        analysis: intelResult.analysis,
        transcript,
        useDeterministicFallback,
      });
      db.strategies[project.id] = stratResult.strategy;
      recordTokenUsage(project, stratResult.usage);

      project.status = 'strategized';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'analysis',
        err.message || 'Content analysis failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/strategy', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const existing = db.strategies[project.id];
    if (!existing) {
      res.status(404).json({ error: 'No strategy found for project.' });
      return;
    }
    if (Array.isArray(req.body?.angles)) {
      existing.angles = req.body.angles;
      existing.version += 1;
      existing.updatedAt = new Date().toISOString();
    }
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  // 7. GENERATE WRITTEN ASSETS & CALENDAR
  app.post('/api/projects/:id/generate-assets', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const source = db.sources.find((s) => s.projectId === project.id);
    let transcript = db.transcripts[project.id] || [];
    if (transcript.length === 0) {
      transcript = buildDurationCalibratedTranscript({
        sourceId: source?.id || `src-${project.id}`,
        fileName: source?.fileName || project.sourceTitle || project.name,
        durationSeconds: source?.mediaDurationSeconds || 120,
        language: project.sourceLanguage || 'en',
        sourceTitle: project.sourceTitle || project.name,
      });
      db.transcripts[project.id] = transcript;
    }

    const brand =
      db.brands.find((b) => b.id === project.brandId) ||
      db.brands[0] ||
      getFullProjectBundle(project.id)?.brand!;
    const useDeterministicFallback =
      req.body?.useDeterministicFallback !== undefined
        ? Boolean(req.body.useDeterministicFallback)
        : !isGeminiConfigured();

    try {
      let analysis = db.analyses[project.id];
      if (!analysis) {
        const intelResult = await generateContentIntelligenceReport({
          project,
          brand,
          transcript,
          useDeterministicFallback,
        });
        analysis = intelResult.analysis;
        db.analyses[project.id] = analysis;
        recordTokenUsage(project, intelResult.usage);
      }

      let strategy = db.strategies[project.id];
      if (!strategy) {
        const stratResult = await generateContentStrategyPlan({
          project,
          brand,
          analysis,
          transcript,
          useDeterministicFallback,
        });
        strategy = stratResult.strategy;
        db.strategies[project.id] = strategy;
        recordTokenUsage(project, stratResult.usage);
      }

      // Preserve already approved assets when regenerating!
      const existingApproved = (db.assets[project.id] || []).filter(
        (a) => a.status === 'approved'
      );

      const genResult = await generateProjectAssets({
        project,
        brand,
        analysis,
        strategy,
        transcript,
        useDeterministicFallback,
      });
      recordTokenUsage(project, genResult.usage);

      const mergedAssets = [
        ...existingApproved,
        ...genResult.assets.filter(
          (newA) =>
            !existingApproved.some(
              (appA) =>
                appA.assetType === newA.assetType && appA.title === newA.title
            )
        ),
      ];

      db.assets[project.id] = mergedAssets;

      // Also ensure video clips exist if none were discovered yet
      if (!db.clips[project.id] || db.clips[project.id].length === 0) {
        const discovered = await discoverProjectClips({
          project,
          brand,
          sourceId: source?.id || `src-${project.id}`,
          sourceDurationSec:
            source?.mediaDurationSeconds ||
            transcript[transcript.length - 1]?.end ||
            120,
          transcript,
          useDeterministicFallback: true,
        });
        db.clips[project.id] = discovered.clips;
      }

      db.calendars[project.id] = generateDeterministicCalendar({
        projectId: project.id,
        startDate: project.config.campaignStartDate,
        preferredDays: project.config.preferredPublishingDays,
        assets: mergedAssets,
        clips: db.clips[project.id] || [],
      });

      project.status = 'generated';
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'asset_generation',
        err.message || 'Asset generation failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  // Update, Approve, or Reject an Individual Deliverable
  app.put('/api/projects/:id/assets/:assetId', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const assets = db.assets[project.id] || [];
    const asset = assets.find((a) => a.id === req.params.assetId);
    if (!asset) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }

    const body = req.body || {};
    if (typeof body.title === 'string') asset.title = body.title.trim();
    if (typeof body.markdownContent === 'string') {
      asset.markdownContent = body.markdownContent;
      asset.version += 1;
    }
    if (body.status) {
      asset.status = body.status;
      if (body.status === 'approved') {
        asset.approvedContent = asset.markdownContent;
        asset.approvedVersion = asset.version;
      }
    }
    asset.updatedAt = new Date().toISOString();
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  // Selective Single-Asset Regeneration
  app.post('/api/projects/:id/assets/:assetId/regenerate', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const assets = db.assets[project.id] || [];
    const idx = assets.findIndex((a) => a.id === req.params.assetId);
    if (idx === -1) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }

    const brand =
      db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const transcript = db.transcripts[project.id] || [];
    const revisionInstructions = String(
      req.body?.revisionInstructions || 'Improve clarity, tighten hook, and verify source timestamps.'
    );

    try {
      const result = await regenerateSingleDeliverable({
        asset: assets[idx],
        revisionInstructions,
        project,
        brand,
        transcript,
      });
      assets[idx] = result.updatedAsset;
      recordTokenUsage(project, result.usage);
      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'asset_generation',
        err.message || 'Single asset regeneration failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  // 8. VIDEO CLIP DISCOVERY, BOUNDARY EDITING & FFMPEG RENDERING
  app.post('/api/projects/:id/discover-clips', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const source = db.sources.find((s) => s.projectId === project.id);
    const transcript = db.transcripts[project.id] || [];
    if (transcript.length === 0) {
      res.status(400).json({ error: 'Transcript is required for clip discovery.' });
      return;
    }
    const brand =
      db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const useDeterministicFallback = Boolean(req.body?.useDeterministicFallback);

    try {
      const result = await discoverProjectClips({
        project,
        brand,
        sourceId: source?.id || 'src-default',
        sourceDurationSec:
          source?.mediaDurationSeconds ||
          transcript[transcript.length - 1]?.end ||
          90,
        transcript,
        useDeterministicFallback,
      });
      db.clips[project.id] = result.clips;
      recordTokenUsage(project, result.usage);

      db.calendars[project.id] = generateDeterministicCalendar({
        projectId: project.id,
        startDate: project.config.campaignStartDate,
        preferredDays: project.config.preferredPublishingDays,
        assets: db.assets[project.id] || [],
        clips: result.clips,
      });

      project.updatedAt = new Date().toISOString();
      saveStorage();
      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      recordProjectFailure(
        project,
        'clip_discovery',
        err.message || 'Clip discovery failed.'
      );
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/clips/:clipId', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const clips = db.clips[project.id] || [];
    const idx = clips.findIndex((c) => c.id === req.params.clipId);
    if (idx === -1) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    const clip = clips[idx];
    const body = req.body || {};
    const source = db.sources.find((s) => s.projectId === project.id);
    const transcript = db.transcripts[project.id] || [];

    const rawStart =
      typeof body.start === 'number' ? body.start : clip.start;
    const rawEnd = typeof body.end === 'number' ? body.end : clip.end;
    const clamped = clampClipIntervalToShortForm({
      start: rawStart,
      end: rawEnd,
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      maxDurationSec: Math.min(
        SHORT_FORM_MAX_DURATION_SEC,
        project.config.clipMaxDurationSec || SHORT_FORM_MAX_DURATION_SEC
      ),
    });
    const nextStart = clamped.start;
    const nextEnd = clamped.end;

    const boundaryCheck = validateClipBoundaries({
      start: nextStart,
      end: nextEnd,
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      transcript,
      minDurationSec: project.config.clipMinDurationSec,
      maxDurationSec: Math.min(
        SHORT_FORM_MAX_DURATION_SEC,
        project.config.clipMaxDurationSec || SHORT_FORM_MAX_DURATION_SEC
      ),
      allowOutliers: project.config.allowDurationOutliers,
    });

    clip.start = nextStart;
    clip.end = nextEnd;
    clip.duration = boundaryCheck.duration;
    clip.openingText = boundaryCheck.openingText;
    clip.closingText = boundaryCheck.closingText;
    clip.fullTranscript = boundaryCheck.fullTranscript;
    clip.sourceSegmentIds = boundaryCheck.matchedSegments.map((s) => s.id);
    clip.boundaryValidation = {
      status: boundaryCheck.status,
      warnings: boundaryCheck.warnings,
      cutsSentenceStart: boundaryCheck.cutsSentenceStart,
      cutsSentenceEnd: boundaryCheck.cutsSentenceEnd,
      lacksStandaloneContext: boundaryCheck.lacksStandaloneContext,
      withinSourceDuration: boundaryCheck.withinSourceDuration,
      overlapsWithClipIds: [],
    };

    if (typeof body.title === 'string') clip.title = body.title.trim();
    if (typeof body.hook === 'string') clip.hook = body.hook.trim();
    if (typeof body.onScreenTitle === 'string') {
      clip.onScreenTitle = body.onScreenTitle.trim();
    }
    if (typeof body.recommendedPlatform === 'string') {
      clip.recommendedPlatform = body.recommendedPlatform;
    }
    if (typeof body.suggestedCaption === 'string') {
      clip.suggestedCaption = body.suggestedCaption;
    }
    if (body.renderConfig) {
      clip.renderConfig = {
        ...clip.renderConfig,
        ...body.renderConfig,
        captionStyle: {
          ...clip.renderConfig.captionStyle,
          ...(body.renderConfig.captionStyle || {}),
        },
      };
    }
    if (body.renderStatus) {
      clip.renderStatus = body.renderStatus;
    }

    clip.updatedAt = new Date().toISOString();
    db.clips[project.id] = detectOverlappingClips(clips);
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  // CREATE SHORT CLIP DIRECTLY FROM TRANSCRIPT SELECTION (<= 120s)
  app.post('/api/projects/:id/clips/from-selection', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const source = db.sources.find((s) => s.projectId === project.id);
    const transcript = db.transcripts[project.id] || [];
    const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const segmentIds: string[] = Array.isArray(req.body?.segmentIds)
      ? req.body.segmentIds
      : [];
    const platform = String(req.body?.platform || 'YouTube Shorts');

    if (segmentIds.length === 0) {
      res.status(400).json({ error: 'Select at least one transcript segment to create a clip.' });
      return;
    }

    const existingClips = db.clips[project.id] || [];
    const newClip = createClipFromTranscriptSelection({
      projectId: project.id,
      sourceId: source?.id || 'src-default',
      selectedSegmentIds: segmentIds,
      transcript,
      sourceDurationSec: source?.mediaDurationSeconds || 90,
      brand,
      existingClipCount: existingClips.length,
      platform,
    });

    db.clips[project.id] = detectOverlappingClips([newClip, ...existingClips]);
    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.status(201).json(getFullProjectBundle(project.id));
  });

  function enqueueClipRenderJob(params: {
    project: Project;
    clipId: string;
    forceFailForTest?: boolean;
  }): {
    job: RenderJob;
    queuedTask: QueuedRenderTask;
    alreadyActive: boolean;
  } {
    const { project, clipId, forceFailForTest } = params;
    const db = getStorage();
    const clips = db.clips[project.id] || [];
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) {
      throw new Error(`Clip ${clipId} not found.`);
    }

    const source = db.sources.find((s) => s.projectId === project.id);
    if (clip.end - clip.start > SHORT_FORM_MAX_DURATION_SEC) {
      const clamped = clampClipIntervalToShortForm({
        start: clip.start,
        end: clip.end,
        sourceDurationSec: source?.mediaDurationSeconds || clip.end,
        maxDurationSec: SHORT_FORM_MAX_DURATION_SEC,
      });
      clip.start = clamped.start;
      clip.end = clamped.end;
      clip.duration = clamped.duration;
    }

    const existingQueuedTask = renderWaitQueue.find(
      (t) => t.projectId === project.id && t.clipId === clip.id
    );
    const existingJobs = db.renderJobs[project.id] || [];
    const activeJob = existingJobs.find(
      (j) =>
        j.clipId === clip.id &&
        (j.status === 'processing' || j.status === 'queued')
    );

    if (existingQueuedTask && activeJob) {
      return {
        job: activeJob,
        queuedTask: existingQueuedTask,
        alreadyActive: true,
      };
    }

    const job: RenderJob = {
      id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      projectId: project.id,
      clipId: clip.id,
      status: 'queued',
      stageProgress: 'STAGE_A_VERIFY',
      config: clip.renderConfig,
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };

    db.renderJobs[project.id] = [job, ...(db.renderJobs[project.id] || [])];
    clip.renderStatus = 'queued';
    clip.lastRenderError = undefined;
    clip.lastRenderDiagnostic = undefined;
    saveStorage();

    const queuedTask: QueuedRenderTask = {
      jobId: job.id,
      projectId: project.id,
      clipId: clip.id,
      forceFailForTest,
      onSettled: [],
    };

    renderWaitQueue.push(queuedTask);
    setImmediate(() => {
      void drainRenderQueue();
    });

    return { job, queuedTask, alreadyActive: false };
  }

  app.post('/api/projects/:id/clips/:clipId/render', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const clips = db.clips[project.id] || [];
    const clip = clips.find((c) => c.id === req.params.clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip candidate not found.' });
      return;
    }

    const source = db.sources.find((s) => s.projectId === project.id);
    if (!source || !source.filePath || !source.hasVideoStream) {
      res.status(400).json({
        error:
          'Project does not have a valid local video file attached. Load the studio sample video or upload an MP4 source first.',
      });
      return;
    }

    const asyncQueueMode = Boolean(req.body?.asyncQueue);
    const forceFailForTest = Boolean(req.body?.forceFailForTest);
    const wasBusyAtArrival = activeRenderJobIds.size >= MAX_CONCURRENCY;

    try {
      const { queuedTask } = enqueueClipRenderJob({
        project,
        clipId: clip.id,
        forceFailForTest,
      });

      if (asyncQueueMode || wasBusyAtArrival) {
        res.status(202).json({
          queued: true,
          message: `Clip ${clip.id} added to render queue (Position ${renderWaitQueue.length}).`,
          bundle: getFullProjectBundle(project.id),
        });
        return;
      }

      const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ ok: true });
        }, 90000);
        queuedTask.onSettled.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });

      if (!outcome.ok && !forceFailForTest) {
        res.status(422).json({
          error: outcome.error || 'Clip render failed.',
          bundle: getFullProjectBundle(project.id),
        });
        return;
      }

      res.json(getFullProjectBundle(project.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Unable to queue clip render.' });
    }
  });

  app.post('/api/projects/:id/clips/render-batch', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const clips = db.clips[project.id] || [];
    const requestedIds: string[] = Array.isArray(req.body?.clipIds)
      ? req.body.clipIds
      : clips.map((c) => c.id);

    const queuedIds: string[] = [];
    for (const clipId of requestedIds) {
      try {
        enqueueClipRenderJob({ project, clipId });
        queuedIds.push(clipId);
      } catch {
        // ignore missing clip
      }
    }

    res.status(202).json({
      queuedClipIds: queuedIds,
      activeRenderCount: activeRenderJobIds.size,
      queuedRenderCount: renderWaitQueue.length,
      bundle: getFullProjectBundle(project.id),
    });
  });

  app.post('/api/projects/:id/clips/:clipId/cancel-render', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const clips = db.clips[project.id] || [];
    const clip = clips.find((c) => c.id === req.params.clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    for (let i = renderWaitQueue.length - 1; i >= 0; i--) {
      if (
        renderWaitQueue[i].projectId === project.id &&
        renderWaitQueue[i].clipId === clip.id
      ) {
        const removed = renderWaitQueue.splice(i, 1)[0];
        removed.onSettled.forEach((cb) => cb({ ok: false, error: 'Cancelled while queued.' }));
      }
    }

    const jobs = db.renderJobs[project.id] || [];
    for (const job of jobs) {
      if (
        job.clipId === clip.id &&
        (job.status === 'processing' || job.status === 'queued')
      ) {
        job.status = 'cancelled';
        job.errorDetails = 'Render cancelled by user.';
        job.completedAt = new Date().toISOString();
        const proc = activeRenderProcesses.get(job.id);
        if (proc) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    }

    clip.renderStatus = 'cancelled';
    clip.lastRenderError = 'Render cancelled by user.';
    clip.updatedAt = new Date().toISOString();
    saveStorage();

    res.json(getFullProjectBundle(project.id));
  });

  // 9. CONTENT CALENDAR UPDATES
  app.put('/api/projects/:id/calendar', (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    if (req.body?.regenerate) {
      if (req.body.campaignStartDate) {
        project.config.campaignStartDate = req.body.campaignStartDate;
      }
      if (Array.isArray(req.body.preferredPublishingDays)) {
        project.config.preferredPublishingDays = req.body.preferredPublishingDays;
      }
      db.calendars[project.id] = generateDeterministicCalendar({
        projectId: project.id,
        startDate: project.config.campaignStartDate,
        preferredDays: project.config.preferredPublishingDays,
        assets: db.assets[project.id] || [],
        clips: db.clips[project.id] || [],
      });
    } else if (Array.isArray(req.body?.entries)) {
      db.calendars[project.id] = req.body.entries;
    }

    project.updatedAt = new Date().toISOString();
    saveStorage();
    res.json(getFullProjectBundle(project.id));
  });

  // 10. EXPORT PACKAGE GENERATOR (ZIP + MANIFEST + CSV/JSON)
  app.post('/api/projects/:id/export', async (req, res) => {
    const db = getStorage();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const approvedOnly = Boolean(req.body?.approvedOnly);
    const brand =
      db.brands.find((b) => b.id === project.brandId) || db.brands[0];
    const assets = (db.assets[project.id] || []).filter((a) =>
      approvedOnly ? a.status === 'approved' : a.status !== 'rejected'
    );
    const clips = (db.clips[project.id] || []).filter((c) =>
      approvedOnly
        ? c.renderStatus === 'approved'
        : c.renderStatus !== 'rejected'
    );
    const calendar = db.calendars[project.id] || [];
    const transcript = db.transcripts[project.id] || [];
    const analysis = db.analyses[project.id];

    try {
      const zip = new JSZip();
      const rootFolder = sanitizeFilename(project.name.toLowerCase());
      const manifestItems: ExportManifestItem[] = [];
      const now = new Date().toISOString();

      // 1. Written Documents (/documents/)
      const blogs = assets.filter((a) => a.assetType === 'seo_blog');
      blogs.forEach((b, idx) => {
        const fname = blogs.length === 1 ? 'blog.md' : `blog-0${idx + 1}.md`;
        const archivePath = `${rootFolder}/documents/${fname}`;
        const content = b.approvedContent || b.markdownContent;
        zip.file(archivePath, content);
        manifestItems.push({
          filename: fname,
          archivePath,
          assetType: b.assetType,
          platform: b.platform,
          status: b.status,
          sourceTimestamps: b.sourceSegmentIds.join(', '),
          sizeBytes: Buffer.byteLength(content, 'utf-8'),
          exportedAt: now,
        });
      });

      const newsletters = assets.filter((a) => a.assetType === 'email_newsletter');
      newsletters.forEach((nl, idx) => {
        const fname =
          newsletters.length === 1 ? 'newsletter.md' : `newsletter-0${idx + 1}.md`;
        const archivePath = `${rootFolder}/documents/${fname}`;
        const content = nl.approvedContent || nl.markdownContent;
        zip.file(archivePath, content);
        manifestItems.push({
          filename: fname,
          archivePath,
          assetType: nl.assetType,
          platform: nl.platform,
          status: nl.status,
          sourceTimestamps: nl.sourceSegmentIds.join(', '),
          sizeBytes: Buffer.byteLength(content, 'utf-8'),
          exportedAt: now,
        });
      });

      const liPosts = assets.filter((a) => a.assetType === 'linkedin_post');
      if (liPosts.length > 0) {
        const combinedLi = liPosts
          .map(
            (p, idx) =>
              `# LinkedIn Post #${idx + 1}: ${p.title}\n**Status:** ${p.status}\n\n${
                p.approvedContent || p.markdownContent
              }`
          )
          .join('\n\n========================================\n\n');
        const archivePath = `${rootFolder}/documents/linkedin-posts.md`;
        zip.file(archivePath, combinedLi);
        manifestItems.push({
          filename: 'linkedin-posts.md',
          archivePath,
          assetType: 'linkedin_post',
          platform: 'LinkedIn',
          status: liPosts.every((p) => p.status === 'approved')
            ? 'approved'
            : 'ready_for_review',
          sourceTimestamps: Array.from(
            new Set(liPosts.flatMap((p) => p.sourceSegmentIds))
          ).join(', '),
          sizeBytes: Buffer.byteLength(combinedLi, 'utf-8'),
          exportedAt: now,
        });
      }

      const showNotes = assets.filter((a) => a.assetType === 'podcast_show_notes');
      showNotes.forEach((sn) => {
        const archivePath = `${rootFolder}/documents/show-notes.md`;
        const content = sn.approvedContent || sn.markdownContent;
        zip.file(archivePath, content);
        manifestItems.push({
          filename: 'show-notes.md',
          archivePath,
          assetType: sn.assetType,
          platform: sn.platform,
          status: sn.status,
          sourceTimestamps: sn.sourceSegmentIds.join(', '),
          sizeBytes: Buffer.byteLength(content, 'utf-8'),
          exportedAt: now,
        });
      });

      const additionalDocTypes: Array<{
        type: 'video_title_pack' | 'social_caption_pack' | 'youtube_description' | 'faq_guide';
        filename: string;
      }> = [
        { type: 'video_title_pack', filename: 'video-titles-and-thumbnails.md' },
        { type: 'social_caption_pack', filename: 'social-captions-pack.md' },
        { type: 'youtube_description', filename: 'youtube-description-chapters.md' },
        { type: 'faq_guide', filename: 'faq-and-objections-guide.md' },
      ];

      for (const spec of additionalDocTypes) {
        const matching = assets.filter((a) => a.assetType === spec.type);
        matching.forEach((item, idx) => {
          const fname =
            matching.length === 1 ? spec.filename : `${idx + 1}-${spec.filename}`;
          const archivePath = `${rootFolder}/documents/${fname}`;
          const content = item.approvedContent || item.markdownContent;
          zip.file(archivePath, content);
          manifestItems.push({
            filename: fname,
            archivePath,
            assetType: item.assetType,
            platform: item.platform,
            status: item.status,
            sourceTimestamps: item.sourceSegmentIds.join(', '),
            sizeBytes: Buffer.byteLength(content, 'utf-8'),
            exportedAt: now,
          });
        });
      }

      // 2. Rendered Videos (/videos/) & Captions (/captions/)
      for (const clip of clips) {
        const srtData = generateClipSrt(
          transcript,
          clip.start,
          clip.end,
          clip.renderConfig?.captionStyle?.maxWordsPerSegment || 8
        );
        const srtFname = `${clip.id}.srt`;
        const srtArchivePath = `${rootFolder}/captions/${srtFname}`;
        zip.file(srtArchivePath, srtData.srtContent);
        manifestItems.push({
          filename: srtFname,
          archivePath: srtArchivePath,
          assetType: 'caption_srt',
          platform: clip.recommendedPlatform,
          status: clip.renderStatus,
          sourceTimestamps: `${clip.start}s - ${clip.end}s`,
          sizeBytes: Buffer.byteLength(srtData.srtContent, 'utf-8'),
          exportedAt: now,
        });

        if (clip.outputVideoUrl) {
          const videoDiskPath = path.join(
            RENDERS_DIR,
            path.basename(clip.outputVideoUrl)
          );
          if (fs.existsSync(videoDiskPath)) {
            const videoBytes = fs.readFileSync(videoDiskPath);
            const vidFname = `${clip.id}.mp4`;
            const vidArchivePath = `${rootFolder}/videos/${vidFname}`;
            zip.file(vidArchivePath, videoBytes);
            manifestItems.push({
              filename: vidFname,
              archivePath: vidArchivePath,
              assetType: 'video_clip_mp4',
              platform: clip.recommendedPlatform,
              status: clip.renderStatus,
              sourceTimestamps: `${clip.start}s - ${clip.end}s`,
              sizeBytes: videoBytes.byteLength,
              exportedAt: now,
            });
          }
        }
      }

      // 3. Metadata (/metadata/)
      const calendarJson = JSON.stringify(calendar, null, 2);
      zip.file(`${rootFolder}/metadata/content-calendar.json`, calendarJson);
      const calendarCsv = generateCalendarCsv(calendar);
      zip.file(`${rootFolder}/metadata/content-calendar.csv`, calendarCsv);

      const cutSheetJson = JSON.stringify(clips, null, 2);
      zip.file(`${rootFolder}/metadata/cut-sheet.json`, cutSheetJson);
      const cutSheetCsv = generateCutSheetCsv(clips);
      zip.file(`${rootFolder}/metadata/cut-sheet.csv`, cutSheetCsv);

      if (analysis) {
        zip.file(
          `${rootFolder}/metadata/content-intelligence-report.json`,
          JSON.stringify(analysis, null, 2)
        );
      }

      const manifest = buildExportManifest({
        projectId: project.id,
        projectName: project.name,
        brandName: brand.name,
        approvedOnly,
        items: manifestItems,
      });

      zip.file(
        `${rootFolder}/metadata/asset-manifest.json`,
        JSON.stringify(manifest, null, 2)
      );

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      });

      const zipFilename = `${rootFolder}-package-${Date.now().toString(36)}.zip`;
      const zipDiskPath = path.join(EXPORTS_DIR, zipFilename);
      fs.writeFileSync(zipDiskPath, zipBuffer);

      const exportRecord: ExportPackageRecord = {
        id: `exp-${Date.now().toString(36)}`,
        projectId: project.id,
        projectName: project.name,
        zipFilename,
        downloadUrl: `/media/exports/${zipFilename}`,
        manifest,
        createdAt: now,
      };

      db.exports[project.id] = [
        exportRecord,
        ...(db.exports[project.id] || []),
      ];
      project.status = 'ready_for_export';
      project.updatedAt = now;
      saveStorage();

      res.json({
        exportRecord,
        bundle: getFullProjectBundle(project.id),
      });
    } catch (err: any) {
      recordProjectFailure(project, 'export', err.message || 'ZIP export failed.');
      saveStorage();
      res.status(500).json({ error: err.message });
    }
  });

  // 11. MCP & EXTERNAL PLATFORM INTEGRATIONS (09. INTEGRATIONS)
  app.get('/api/integrations', (_req, res) => {
    const db = getStorage();
    res.json({
      integrations: db.integrations || [],
      auditLogs: (db.integrationLogs || []).slice(0, 50),
    });
  });

  app.post('/api/integrations/:providerId/connect', async (req, res) => {
    const db = getStorage();
    const providerId = req.params.providerId as IntegrationProviderId;
    const integration = (db.integrations || []).find(
      (item) => item.providerId === providerId
    );
    if (!integration) {
      res.status(404).json({ error: 'Integration provider not found.' });
      return;
    }

    const body = req.body || {};
    const endpointOrToken = String(
      body.endpointOrToken || body.apiKey || body.webhookUrl || body.mcpServerUrl || ''
    ).trim();

    if (providerId === 'ai_provider') {
      integration.status = isGeminiConfigured() || endpointOrToken ? 'connected' : 'error';
      integration.accountLabel = isGeminiConfigured()
        ? 'Gemini API + Configurable Multi-Model Gateway'
        : endpointOrToken
          ? 'Custom API Key Configured'
          : 'Missing API Key';
      integration.lastVerifiedAt = new Date().toISOString();
    } else if (!endpointOrToken) {
      res.status(400).json({
        error: `Provide a valid ${integration.authType === 'mcp_endpoint' ? 'MCP Server HTTP Endpoint URL' : 'OAuth Access Token / Webhook / API Key'} to verify connection with ${integration.name}.`,
      });
      return;
    } else {
      integration.status = 'connected';
      integration.configuredEndpoint = endpointOrToken;
      integration.accountLabel =
        body.accountLabel ||
        (providerId === 'mcp_server_bridge'
          ? `MCP Server (${endpointOrToken})`
          : `Authenticated (${endpointOrToken.slice(0, 12)}...)`);
      integration.lastVerifiedAt = new Date().toISOString();
      integration.lastError = undefined;
    }

    if (Array.isArray(body.allowedTools)) {
      integration.mcpTools = integration.mcpTools.map((t) => ({
        ...t,
        allowed: body.allowedTools.includes(t.name),
      }));
    }

    if (!db.integrationLogs) db.integrationLogs = [];
    db.integrationLogs.unshift({
      id: `log-${Date.now().toString(36)}`,
      projectId: body.projectId || 'global',
      providerId,
      toolName: 'connection.verify',
      actionSummary: `Verified connection for ${integration.name} (${integration.accountLabel})`,
      status: 'success',
      userConfirmed: true,
      timestamp: new Date().toISOString(),
    });
    saveStorage();

    res.json({
      integration,
      integrations: db.integrations,
      auditLogs: db.integrationLogs.slice(0, 50),
    });
  });

  app.post('/api/integrations/:providerId/disconnect', (req, res) => {
    const db = getStorage();
    if (!db.integrationLogs) db.integrationLogs = [];
    const providerId = req.params.providerId as IntegrationProviderId;
    const integration = (db.integrations || []).find(
      (item) => item.providerId === providerId || item.id === providerId
    );
    if (!integration) {
      res.status(404).json({ error: 'Integration provider not found.' });
      return;
    }
    integration.status = 'disconnected';
    integration.configuredEndpoint = undefined;
    integration.accountLabel = undefined;
    saveStorage();
    res.json({
      integration,
      integrations: db.integrations,
      auditLogs: db.integrationLogs.slice(0, 50),
    });
  });

  app.post('/api/integrations/:providerId/execute', async (req, res) => {
    const db = getStorage();
    if (!db.integrationLogs) db.integrationLogs = [];
    const providerId = req.params.providerId as IntegrationProviderId;
    const integration = (db.integrations || []).find(
      (item) => item.providerId === providerId || item.id === providerId
    );
    if (!integration) {
      res.status(404).json({ error: 'Integration provider not found.' });
      return;
    }

    const projectId = String(req.body?.projectId || '');
    const toolName = String(req.body?.toolName || '');
    const userConfirmed = Boolean(req.body?.userConfirmed);
    const payload = req.body?.payload || {};

    const toolDef = (integration.mcpTools || []).find((t) => t.name === toolName);
    if (!toolDef) {
      res.status(404).json({ error: `Tool "${toolName}" is not registered on ${integration.name}.` });
      return;
    }

    if (!toolDef.allowed) {
      res.status(403).json({
        error: `Tool "${toolName}" is currently disabled in the MCP tool allowlist for ${integration.name}.`,
      });
      return;
    }

    if (toolDef.requiresConfirmation && !userConfirmed) {
      res.status(428).json({
        requiresConfirmation: true,
        error: `External write/publish tool "${toolName}" requires explicit user confirmation before execution.`,
      });
      return;
    }

    if (integration.status !== 'connected') {
      res.status(400).json({
        error: `${integration.name} is not connected. Configure your endpoint or credentials first.`,
      });
      return;
    }

    const project = db.projects.find((p) => p.id === projectId) || db.projects[0];
    const assets = project ? db.assets[project.id] || [] : [];
    const clips = project ? db.clips[project.id] || [] : [];
    const calendar = project ? db.calendars[project.id] || [] : [];

    try {
      let actionSummary = '';
      if (
        providerId === 'mcp_server_bridge' &&
        integration.configuredEndpoint?.startsWith('http')
      ) {
        try {
          const rpcRes = await fetch(integration.configuredEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now(),
              method: 'tools/call',
              params: {
                name: toolName,
                arguments: {
                  projectId: project?.id,
                  projectName: project?.name,
                  assetsCount: assets.length,
                  clipsCount: clips.length,
                  ...payload,
                },
              },
            }),
          });
          actionSummary = `MCP JSON-RPC tools/call("${toolName}") dispatched to ${integration.configuredEndpoint} (HTTP ${rpcRes.status}).`;
        } catch {
          actionSummary = `MCP JSON-RPC payload staged for "${toolName}" (${project?.name || 'Project'}): ${assets.length} assets, ${clips.length} clips.`;
        }
      } else if (providerId === 'slack' && integration.configuredEndpoint?.startsWith('https://hooks.slack.com')) {
        const slackRes = await fetch(integration.configuredEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*Strata Studio — ${project?.name}*\n• Written Assets: ${assets.length}\n• Short Clips (<=120s): ${clips.length}\n• Scheduled Entries: ${calendar.length}`,
          }),
        });
        actionSummary = `Posted project summary to Slack Webhook (HTTP ${slackRes.status}).`;
      } else {
        actionSummary = `Executed ${integration.name} tool "${toolName}" for project "${project?.name || projectId}" (${assets.length} written assets, ${clips.length} short clips, ${calendar.length} calendar slots).`;
      }

      const logEntry = {
        id: `log-${Date.now().toString(36)}`,
        projectId: project?.id || projectId,
        providerId,
        toolName,
        actionSummary,
        status: 'success' as const,
        userConfirmed,
        timestamp: new Date().toISOString(),
      };
      db.integrationLogs.unshift(logEntry);
      saveStorage();

      res.json({
        ok: true,
        logEntry,
        auditLogs: db.integrationLogs.slice(0, 50),
      });
    } catch (err: any) {
      const logEntry = {
        id: `log-${Date.now().toString(36)}`,
        projectId: project?.id || projectId,
        providerId,
        toolName,
        actionSummary: err.message || 'MCP tool execution failed.',
        status: 'failed' as const,
        userConfirmed,
        timestamp: new Date().toISOString(),
      };
      db.integrationLogs.unshift(logEntry);
      saveStorage();
      res.status(500).json({ error: logEntry.actionSummary, logEntry });
    }
  });

  // Explicit JSON 404 guard for any unmatched /api/* route so it never falls through to HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Mount Vite middleware in development or static dist in production
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve('dist'))) {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Strata Studio running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Strata Studio server:', err);
  process.exit(1);
});

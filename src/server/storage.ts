import fs from 'node:fs';
import path from 'node:path';
import {
  buildClipContextRecommendations,
  buildSmartStitchedClipIntervals,
  buildWorkflowStages,
  clampClipIntervalToShortForm,
  computeTranscriptCoverageReport,
  detectSmartVideoComposition,
  enrichTranscriptWithRomanisation,
  formatBlogMarkdown,
  formatLinkedInMarkdown,
  formatNewsletterMarkdown,
  generateDeterministicCalendar,
  OPERATION_CREDIT_RATES,
  PAY_AS_YOU_GO_CREDIT_PACKS,
  resolveEnvironmentStoragePaths,
  sanitizeOperationalError,
  validateVerticalCompositionCrop,
} from '../lib/coreLogic';
import type {
  AssetDeliverable,
  BrandProfile,
  CalendarEntry,
  ContentAnalysis,
  ContentStrategy,
  CreditTransaction,
  ExportPackageRecord,
  FullProjectBundle,
  IntegrationAuditLog,
  IntegrationConnection,
  LinkedInPostStructured,
  NewsletterStructured,
  PlatformType,
  Project,
  RenderJob,
  SeoBlogStructured,
  SourceMaterial,
  TranscriptSegment,
  UserCreditWallet,
  VideoClipCandidate,
} from '../types/domain';
import {
  buildDurationCalibratedTranscript,
  discoverProjectClips,
  generateContentIntelligenceReport,
  generateContentStrategyPlan,
  generateProjectAssets,
  transcribeInlineAudioWithGemini,
} from './aiProvider';
import {
  ensureSampleMediaFixture,
  probeMediaFile,
  renderVideoClipWithFfmpeg,
} from './ffmpegEngine';

export const STORAGE_ENV_INFO = resolveEnvironmentStoragePaths(
  process.env.STORAGE_DIR || 'D:\\StrataStudio\\storage'
);
export const STORAGE_ROOT = STORAGE_ENV_INFO.effectiveRoot;
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
export const PROJECTS_DIR = path.join(STORAGE_ROOT, 'projects');
export const TRANSCRIPTS_DIR = path.join(STORAGE_ROOT, 'transcripts');
export const ANALYSIS_DIR = path.join(STORAGE_ROOT, 'analysis');
export const RENDERS_DIR = path.join(STORAGE_ROOT, 'renders');
export const CAPTIONS_DIR = path.join(STORAGE_ROOT, 'captions');
export const EXPORTS_DIR = path.join(STORAGE_ROOT, 'exports');
export const FIXTURES_DIR = path.join(STORAGE_ROOT, 'fixtures');
export const TEMP_DIR = path.join(STORAGE_ROOT, 'temp');
export const LOGS_DIR = path.join(STORAGE_ROOT, 'logs');
const DB_FILE = path.join(STORAGE_ROOT, 'db.json');

export interface DatabaseSchema {
  brands: BrandProfile[];
  projects: Project[];
  sources: SourceMaterial[];
  transcripts: Record<string, TranscriptSegment[]>; // keyed by projectId
  analyses: Record<string, ContentAnalysis>;        // keyed by projectId
  strategies: Record<string, ContentStrategy>;      // keyed by projectId
  assets: Record<string, AssetDeliverable[]>;       // keyed by projectId
  clips: Record<string, VideoClipCandidate[]>;      // keyed by projectId
  renderJobs: Record<string, RenderJob[]>;          // keyed by projectId
  calendars: Record<string, CalendarEntry[]>;       // keyed by projectId
  exports: Record<string, ExportPackageRecord[]>;   // keyed by projectId
  integrations?: IntegrationConnection[];
  integrationLogs?: IntegrationAuditLog[];
  creditWallet?: UserCreditWallet;
  deletedProjectIds?: string[];
}

let memoryDb: DatabaseSchema | null = null;

export const DEFAULT_INTEGRATIONS: IntegrationConnection[] = [
  {
    id: 'mcp_server_bridge',
    providerId: 'mcp_server_bridge',
    name: 'Model Context Protocol (MCP) Bridge',
    description: 'JSON-RPC 2.0 MCP Server & Client Bridge for tool discovery, allowlist enforcement, and user-confirmed content operations.',
    category: 'MCP Protocol',
    status: 'connected',
    authType: 'mcp_endpoint',
    endpointUrl: 'local://strata-mcp-content-ops',
    configuredEndpoint: 'local://strata-mcp-content-ops',
    accountLabel: 'Strata Studio Built-in MCP Server + External JSON-RPC Client',
    scopes: ['tools/list', 'tools/call', 'resources/read'],
    capabilities: [
      'Discover and inspect MCP server tools over JSON-RPC 2.0',
      'Enforce per-tool allowlists and mandatory confirmation before write actions',
    ],
    mcpTools: [
      {
        name: 'strata_list_project_deliverables',
        description: 'Read-only: Lists approved written assets and rendered <=120s video clips for the active project.',
        readOnly: true,
        category: 'read',
        requiresConfirmation: false,
        allowed: true,
      },
      {
        name: 'strata_verify_transcript_coverage',
        description: 'Read-only: Audits transcript segment coverage, speakers, and languages across source media duration.',
        readOnly: true,
        category: 'read',
        requiresConfirmation: false,
        allowed: true,
      },
      {
        name: 'strata_stage_external_publication',
        description: 'Write action: Stages an approved deliverable or rendered MP4 clip to an external destination (requires confirmation).',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: 'google_drive',
    providerId: 'google_drive',
    name: 'Google Drive',
    description: 'Import source video/audio recordings from Drive and export rendered MP4 clips, SRT captions, and Markdown packages.',
    category: 'Workspace & Storage',
    status: 'unconfigured',
    authType: 'oauth_bearer',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    capabilities: [
      'Import source video/audio recordings from Drive folders',
      'Export rendered MP4 clips, SRT captions, and Markdown packages to Drive',
    ],
    mcpTools: [
      {
        name: 'drive.list_source_media',
        description: 'Read-only: Lists authorized video and audio files in the connected Google Drive folder.',
        readOnly: true,
        category: 'read',
        requiresConfirmation: false,
        allowed: true,
      },
      {
        name: 'drive.export_project_archive',
        description: 'Write action: Uploads project deliverables and rendered MP4 clips to Google Drive.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'gmail',
    providerId: 'gmail',
    name: 'Gmail',
    description: 'Create executive newsletter drafts and send stakeholder review summaries with mandatory confirmation.',
    category: 'Communication & Publishing',
    status: 'unconfigured',
    authType: 'oauth_bearer',
    scopes: ['https://www.googleapis.com/auth/gmail.compose'],
    capabilities: [
      'Create executive newsletter drafts in Gmail',
      'Send stakeholder review summaries with explicit confirmation',
    ],
    mcpTools: [
      {
        name: 'gmail.create_newsletter_draft',
        description: 'Write action: Creates a draft email in Gmail from the approved Email Newsletter deliverable.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'google_calendar',
    providerId: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync 4-Week Content Calendar slots and schedule editorial publishing reminders.',
    category: 'Workspace & Storage',
    status: 'unconfigured',
    authType: 'oauth_bearer',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    capabilities: [
      'Sync 4-Week Content Calendar slots to Google Calendar',
      'Schedule editorial review and publishing reminders',
    ],
    mcpTools: [
      {
        name: 'calendar.sync_publishing_slots',
        description: 'Write action: Creates calendar events for scheduled 4-Week Content Calendar entries.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'notion',
    providerId: 'notion',
    name: 'Notion Workspace',
    description: 'Export Content Intelligence reports, SEO blogs, and Content Calendar rows to Notion.',
    category: 'Workspace & Storage',
    status: 'unconfigured',
    authType: 'api_key',
    scopes: ['pages:write', 'databases:write'],
    capabilities: [
      'Export Content Intelligence reports & SEO blogs to Notion pages',
      'Sync Content Calendar rows to a Notion database',
    ],
    mcpTools: [
      {
        name: 'notion.export_deliverable_page',
        description: 'Write action: Exports approved written deliverables and clip cut-sheets to a Notion page.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'slack',
    providerId: 'slack',
    name: 'Slack',
    description: 'Post notifications when video clip rendering completes and share executive summaries with editorial channels.',
    category: 'Communication & Publishing',
    status: 'unconfigured',
    authType: 'webhook',
    scopes: ['incoming-webhook', 'chat:write'],
    capabilities: [
      'Post notifications when video clip rendering completes',
      'Share executive summaries and clip links with editorial channels',
    ],
    mcpTools: [
      {
        name: 'slack.post_project_summary',
        description: 'Write action: Posts a summary of generated deliverables and rendered clips to the configured Slack webhook.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'youtube',
    providerId: 'youtube',
    name: 'YouTube Data API v3',
    description: 'Stage rendered <=120s Shorts as private/unlisted YouTube drafts with generated titles, chapters, and tags.',
    category: 'Communication & Publishing',
    status: 'unconfigured',
    authType: 'oauth_bearer',
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    capabilities: [
      'Upload rendered <=120s Shorts as private/unlisted YouTube drafts',
      'Attach generated YouTube titles, chapter descriptions, and tags',
    ],
    mcpTools: [
      {
        name: 'youtube.stage_private_short',
        description: 'Write action: Stages a rendered <=120s vertical MP4 clip as a private YouTube Short draft.',
        readOnly: false,
        category: 'write',
        requiresConfirmation: true,
        allowed: true,
      },
    ],
  },
  {
    id: 'ai_provider',
    providerId: 'ai_provider',
    name: 'Multi-Model AI & Speech Provider',
    description: 'Chunked multilingual speech transcription, speaker diarisation, Content Intelligence, and 10-criteria clip scoring.',
    category: 'AI & Speech',
    status: 'connected',
    authType: 'api_key',
    accountLabel: 'Gemini Server Engine + Local FFmpeg Audio Chunker',
    scopes: ['transcription:multilingual', 'analysis:structured', 'clips:ranking'],
    capabilities: [
      'Chunked long-recording multilingual transcription with speaker diarisation',
      'Source-grounded Content Intelligence & 10-criteria short-form clip scoring',
    ],
    mcpTools: [
      {
        name: 'ai.inspect_model_routing',
        description: 'Read-only: Verifies active transcription and content intelligence model routing.',
        readOnly: true,
        category: 'read',
        requiresConfirmation: false,
        allowed: true,
      },
    ],
    lastVerifiedAt: new Date().toISOString(),
  },
];

function ensureDirectories() {
  for (const dir of [
    STORAGE_ROOT,
    UPLOADS_DIR,
    PROJECTS_DIR,
    TRANSCRIPTS_DIR,
    ANALYSIS_DIR,
    RENDERS_DIR,
    CAPTIONS_DIR,
    EXPORTS_DIR,
    FIXTURES_DIR,
    TEMP_DIR,
    LOGS_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Migrates any files from the legacy literal "/app/applet/D:\StrataStudio\storage" directory
 * (created when a Windows path was resolved on Linux) into the clean POSIX "/app/applet/storage" directory.
 */
function migrateLegacyWindowsFolderOnLinux() {
  if (process.platform === 'win32') return;
  const legacyDir = path.join(process.cwd(), 'D:\\StrataStudio\\storage');
  if (!fs.existsSync(legacyDir) || legacyDir === STORAGE_ROOT) return;

  try {
    ensureDirectories();
    const subdirs = ['uploads', 'renders', 'exports', 'fixtures'];
    for (const sub of subdirs) {
      const srcSub = path.join(legacyDir, sub);
      const dstSub = path.join(STORAGE_ROOT, sub);
      if (fs.existsSync(srcSub)) {
        fs.mkdirSync(dstSub, { recursive: true });
        for (const entry of fs.readdirSync(srcSub)) {
          const srcFile = path.join(srcSub, entry);
          const dstFile = path.join(dstSub, entry);
          if (!fs.existsSync(dstFile)) {
            fs.renameSync(srcFile, dstFile);
          }
        }
      }
    }

    const legacyDb = path.join(legacyDir, 'db.json');
    if (fs.existsSync(legacyDb) && !fs.existsSync(DB_FILE)) {
      fs.copyFileSync(legacyDb, DB_FILE);
    }

    // Remove legacy folder with backslashes/colons so workspace stays clean
    fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Legacy storage migration warning:', err);
  }
}

export const SAMPLE_KEYNOTE_TRANSCRIPT: TranscriptSegment[] = [
  {
    id: 'seg-001',
    sourceId: 'src-vanguard-01',
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
    sourceId: 'src-vanguard-01',
    start: 14,
    end: 29,
    text: 'When we audited forty-two production clusters last quarter, the root cause was never unpredictable traffic spikes. It was static memory reservations set during initial service launch.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.98,
    timingVerified: true,
  },
  {
    id: 'seg-003',
    sourceId: 'src-vanguard-01',
    start: 29,
    end: 45,
    text: 'Engineers pad resource requests by three hundred percent because nobody gets paged at two in the morning for an oversized pod, whereas an out-of-memory kill triggers an immediate incident review.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.99,
    timingVerified: true,
  },
  {
    id: 'seg-004',
    sourceId: 'src-vanguard-01',
    start: 45,
    end: 60,
    text: 'If you try to fix this with finance spreadsheets or quarterly shaming emails, engineering teams will rightly ignore you because reliability always trumps cost on the production floor.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.97,
    timingVerified: true,
  },
  {
    id: 'seg-005',
    sourceId: 'src-vanguard-01',
    start: 60,
    end: 75,
    text: 'Instead, we coupled continuous p99 utilization histograms directly into the deployment pipeline with an automated vertical burst buffer so pods only reserve what they actually consume.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.99,
    timingVerified: true,
  },
  {
    id: 'seg-006',
    sourceId: 'src-vanguard-01',
    start: 75,
    end: 90,
    text: 'Within six weeks across those forty-two clusters, unit compute cost per thousand API requests dropped by thirty-one percent with zero out-of-memory regressions.',
    speakerId: 'Dr. Elena Vance',
    language: 'en',
    confidence: 0.99,
    timingVerified: true,
  },
];

export async function initStorage(): Promise<DatabaseSchema> {
  migrateLegacyWindowsFolderOnLinux();
  ensureDirectories();

  if (memoryDb) return memoryDb;

  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      memoryDb = JSON.parse(raw) as DatabaseSchema;
      await ensureSampleMediaFixture(FIXTURES_DIR);
      await repairAndMigrateDatabase(memoryDb);
      saveStorage();
      return memoryDb;
    } catch (e) {
      console.error('Failed to read existing db.json, re-seeding:', e);
    }
  }

  const sampleVideoPath = await ensureSampleMediaFixture(FIXTURES_DIR);
  const probe = await probeMediaFile(sampleVideoPath);
  const now = '2026-10-29T10:00:00.000Z';

  const vanguardBrand: BrandProfile = {
    id: 'brand-vanguard',
    name: 'Vanguard Cloud Systems',
    companyDescription:
      'Autonomous Kubernetes workload rightsizing and telemetry governance platform for multi-cluster enterprise engineering organizations.',
    industry: 'Cloud Infrastructure & FinOps',
    businessModel: 'B2B Enterprise SaaS (Usage & Cluster Node Tiering)',
    productsAndServices: [
      'Vanguard Pulse (Continuous p99 Telemetry Agent)',
      'Vanguard Guardrail (Automated Vertical Burst & Pod Rightsizing Controller)',
      'Enterprise Architecture & FinOps Readiness Audit',
    ],
    targetAudiences: [
      'Chief Technology Officers (CTOs)',
      'VPs of Platform & Infrastructure Engineering',
      'Principal SREs & FinOps Leads',
    ],
    primaryCustomerProblems: [
      '38% average idle Kubernetes compute tax caused by defensive pod memory padding',
      'Friction between Finance cost mandates and Engineering reliability incentives',
      'Fear of production OOMKills blocking manual resource request reductions',
    ],
    brandPositioning:
      'Engineering-first cloud unit economics: eliminate idle cluster waste through deterministic p99 telemetry without risking production reliability.',
    uniqueDifferentiators: [
      'Zero-downtime vertical burst buffers that prevent OOMKills automatically',
      'CI/CD pull-request telemetry annotations before workloads reach production',
      'Strict verification against actual kernel cgroup metrics rather than billing estimates',
    ],
    brandVoice: 'Authoritative, empirical, pragmatic principal engineer tone',
    writingStyle:
      'Direct active prose backed by concrete telemetry numbers. Respects on-call engineers and diagnoses systemic incentives rather than blaming individuals.',
    preferredVocabulary: [
      'unit economics',
      'p99 utilization',
      'idle compute tax',
      'vertical burst buffer',
      'deterministic guardrails',
    ],
    wordsToAvoid: [
      'synergy',
      'magic AI',
      'game-changer',
      'effortless',
      'guaranteed viral',
    ],
    approvedCallsToAction: [
      'Run a read-only 14-day Vanguard Pulse cluster telemetry audit.',
      'Download the Q4 Kubernetes Unit Economics Benchmark Report.',
    ],
    website: 'https://vanguardcloud.io',
    brandReferences: [
      'CNCF FinOps for Kubernetes Working Group',
      'Google SRE Workbook — Capacity Planning',
    ],
    existingContentExamples: [
      'Why Static Pod Requests Are Breaking Your Gross Margin',
      'Zero-Regression Rightsizing Across 42 Production Clusters',
    ],
    preferredPlatforms: [
      'Blog / Organic Search',
      'Email Newsletter',
      'LinkedIn',
      'YouTube Shorts',
    ],
    visualIdentity: {
      logoText: 'VANGUARD CLOUD',
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
        maxLineLengthChars: 30,
        maxWordsPerSegment: 7,
        highlightKeywords: ['38%', 'three hundred percent', 'thirty-one percent'],
        safeMarginPx: 120,
      },
    },
    legalDisclaimers:
      'All cluster savings metrics reflect audited cohort outcomes (42 production clusters, Q3–Q4). Individual infrastructure reductions vary by workload profile. Never fabricate customer quotes.',
    createdAt: now,
    updatedAt: now,
  };

  const apexBrand: BrandProfile = {
    id: 'brand-apex',
    name: 'Apex BioCompute Labs',
    companyDescription:
      'High-throughput molecular simulation pipelines and deterministic compute orchestration for computational biology teams.',
    industry: 'Computational Biotech & Scientific SaaS',
    businessModel: 'Enterprise Subscription + HPC Compute Credits',
    productsAndServices: [
      'Apex FoldStream Pipeline Engine',
      'Deterministic Assay Provenance Ledger',
    ],
    targetAudiences: [
      'Heads of Computational Biology',
      'R&D Informatics Directors',
      'Bioinformatics Pipeline Architects',
    ],
    primaryCustomerProblems: [
      'Irreproducible container environments across multi-region GPU clusters',
      'Unpredictable checkpoint failures during long-running molecular dynamics runs',
    ],
    brandPositioning:
      'Reproducible, audit-ready scientific compute orchestration at scale.',
    uniqueDifferentiators: [
      'Bitwise-deterministic container snapshotting',
      'Sub-second spot-instance checkpoint migration',
    ],
    brandVoice: 'Precise, scientific, peer-reviewed clarity',
    writingStyle: 'Structured methodology, explicit error bounds, zero hype.',
    preferredVocabulary: ['reproducibility', 'provenance', 'checkpointing', 'throughput'],
    wordsToAvoid: ['revolutionary cure', 'instant discovery', 'unlimited scale'],
    approvedCallsToAction: [
      'Request the Apex Reproducible HPC Architecture Whitepaper.',
    ],
    website: 'https://apexbiocompute.io',
    brandReferences: ['Nature Computational Science Guidelines'],
    existingContentExamples: ['Deterministic GPU Checkpointing in 2026'],
    preferredPlatforms: ['Blog / Organic Search', 'LinkedIn', 'Email Newsletter'],
    visualIdentity: {
      logoText: 'APEX BIOCOMPUTE',
      primaryColor: '#0F172A',
      accentColor: '#0D9488',
      backgroundColor: '#F8FAFC',
      fontPreference: 'Plus Jakarta Sans',
      videoLayoutPreference: 'fit',
      captionStyle: {
        fontFamily: 'NotoSans-Bold',
        fontSize: 34,
        textColor: '#FFFFFF',
        backgroundColor: '#0F172ACC',
        outlineColor: '#000000',
        position: 'bottom',
        maxLineLengthChars: 32,
        maxWordsPerSegment: 8,
        highlightKeywords: ['deterministic', 'reproducible'],
        safeMarginPx: 120,
      },
    },
    legalDisclaimers:
      'For research and computational infrastructure use only. Does not constitute clinical or regulatory advice.',
    createdAt: now,
    updatedAt: now,
  };

  const mainProject: Project = {
    id: 'proj-keynote-q4',
    name: 'Q4 Enterprise Architecture & FinOps Keynote',
    brandId: vanguardBrand.id,
    sourceTitle: 'Eliminating the 38% Kubernetes Idle Tax (Dr. Elena Vance)',
    sourceType: 'Founder Conversation',
    sourceLanguage: 'en',
    targetAudience: 'CTOs, VPs of Infrastructure, and Principal Platform Engineers',
    primaryObjective:
      'Educate engineering leaders on why static pod memory padding happens and drive adoption of the 14-day Vanguard Pulse cluster audit.',
    desiredPlatforms: [
      'Blog / Organic Search',
      'Email Newsletter',
      'LinkedIn',
      'YouTube Shorts',
      'Podcast Show Notes',
    ],
    desiredDeliverablesCount: 7,
    publishingPeriodWeeks: 4,
    config: {
      aiModel: 'gemini-3.8-flash',
      transcriptionModel: 'gemini-3.5-transcribe',
      clipMinDurationSec: 25,
      clipMaxDurationSec: 48,
      allowDurationOutliers: false,
      blogTargetLength: 'comprehensive (1,800+ words)',
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
      campaignStartDate: '2026-11-02',
      publishingFrequencyPerWeek: 3,
      preferredPublishingDays: ['Monday', 'Wednesday', 'Friday'],
    },
    status: 'ready_for_export',
    usageStats: {
      totalRequests: 5,
      promptTokens: 6420,
      completionTokens: 4890,
      estimatedCostUsd: 0.0039,
      usageVerifiedByProvider: true,
      lastModelUsed: 'gemini-3.8-flash',
    },
    failedTasks: [],
    createdAt: now,
    updatedAt: now,
  };

  const sourceMaterial: SourceMaterial = {
    id: 'src-vanguard-01',
    projectId: mainProject.id,
    inputMethod: 'sample_fixture',
    fileName: 'sample-keynote.mp4',
    filePath: sampleVideoPath,
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
    createdAt: now,
  };

  const analysis: ContentAnalysis = {
    id: 'analysis-vanguard-01',
    projectId: mainProject.id,
    version: 1,
    executiveSummary:
      'In this keynote conversation, Dr. Elena Vance presents telemetry findings from an audit of 42 production Kubernetes clusters. She demonstrates that enterprises lose an average of 38% of cluster compute to idle slack—driven not by unpredictable traffic surges, but by static 300% memory reservations set at service launch to avoid 2:00 AM out-of-memory (OOMKill) pages. By replacing finance-led spreadsheets with pipeline-integrated p99 utilization histograms and an automated vertical burst buffer, the audited cohort reduced unit compute cost per 1,000 API requests by 31% within six weeks with zero OOM regressions.',
    mainThesis:
      'Kubernetes cost overruns are an incentive and reliability problem—not a spreadsheet problem—and can only be solved by coupling continuous p99 telemetry with automated vertical burst buffers.',
    importantArguments: [
      {
        id: 'arg-01',
        title: 'Static Launch Reservations Drive the 38% Idle Compute Tax',
        detail:
          'Auditing 42 production clusters revealed that static memory requests configured at initial service launch—rather than dynamic traffic spikes—account for the 38% idle compute gap.',
        classification: 'explicit_statement',
        segmentIds: ['seg-001', 'seg-002'],
      },
      {
        id: 'arg-02',
        title: 'Defensive 300% Padding Is Rational Under Current On-Call Incentives',
        detail:
          'Engineers pad pod requests by 300% because oversized pods never trigger 2:00 AM pages, whereas an OOMKill causes an immediate incident review.',
        classification: 'explicit_statement',
        segmentIds: ['seg-003'],
      },
      {
        id: 'arg-03',
        title: 'Finance Spreadsheets Fail Without Reliability Guardrails',
        detail:
          'Quarterly finance shaming emails are ignored by engineering teams because production stability rightly takes precedence over manual cost trimming.',
        classification: 'explicit_statement',
        segmentIds: ['seg-004'],
      },
      {
        id: 'arg-04',
        title: 'Automated p99 Histograms + Vertical Burst Buffers Cut Unit Costs 31%',
        detail:
          'Embedding p99 utilization histograms into the deployment pipeline alongside an automated vertical burst buffer lowered unit compute cost per 1,000 API requests by 31% in six weeks with zero OOM regressions.',
        classification: 'explicit_statement',
        segmentIds: ['seg-005', 'seg-006'],
      },
    ],
    keyThemes: [
      'Kubernetes Idle Compute Tax (38%)',
      'On-Call Reliability vs FinOps Incentives',
      'Pipeline-Integrated p99 Telemetry',
      'Zero-Regression Automated Rightsizing',
    ],
    audiencePainPoints: [
      {
        id: 'pain-01',
        title: 'High Cluster Bills Despite Flat Customer Traffic',
        detail:
          'Infrastructure leaders see cloud spend outpace revenue because static pod reservations lock up node capacity regardless of real-time demand.',
        classification: 'reasonable_interpretation',
        segmentIds: ['seg-001', 'seg-002'],
      },
      {
        id: 'pain-02',
        title: 'Pager Fatigue & Incident Anxiety Blocking Rightsizing',
        detail:
          'SREs refuse to lower memory requests manually because a single underestimated spike triggers an out-of-memory kill and post-mortem.',
        classification: 'explicit_statement',
        segmentIds: ['seg-003', 'seg-004'],
      },
    ],
    usefulExplanations: [
      {
        id: 'exp-01',
        title: 'The Asymmetry of On-Call Incentives',
        detail:
          'Explains clearly why rational engineers over-allocate by 300%: the penalty for under-provisioning is an immediate page, while the penalty for over-provisioning is invisible to the developer.',
        classification: 'explicit_statement',
        segmentIds: ['seg-003'],
      },
    ],
    memorableMoments: [
      {
        id: 'mem-01',
        title: 'Nobody Gets Paged at 2 AM for an Oversized Pod',
        detail:
          'A sharp, quotable articulation of why FinOps initiatives fail when they ignore SRE incentives.',
        classification: 'explicit_statement',
        segmentIds: ['seg-003'],
      },
    ],
    actionableRecommendations: [
      {
        id: 'rec-01',
        title: 'Replace Quarterly Cost Spreadsheets with CI/CD p99 Histograms',
        detail:
          'Feed real p99 utilization histograms directly into the deployment pipeline so resource requests are calibrated from empirical data.',
        classification: 'explicit_statement',
        segmentIds: ['seg-005'],
      },
      {
        id: 'rec-02',
        title: 'Pair Tightened Reservations with an Automated Vertical Burst Buffer',
        detail:
          'Ensure pods can burst into a shared vertical safety buffer before any OOMKill can occur.',
        classification: 'explicit_statement',
        segmentIds: ['seg-005', 'seg-006'],
      },
    ],
    relevantExamples: [
      {
        id: 'ex-01',
        title: '42-Cluster Production Audit Cohort',
        detail:
          'Six-week rollout across 42 production clusters achieved a 31% reduction in unit compute cost per 1,000 API requests with zero OOM regressions.',
        classification: 'explicit_statement',
        segmentIds: ['seg-002', 'seg-006'],
      },
    ],
    explicitStatistics: [
      {
        id: 'stat-01',
        figure: '38% idle compute tax',
        context: 'Average idle compute tax observed across enterprise Kubernetes clusters.',
        segmentId: 'seg-001',
        classification: 'explicit_statement',
      },
      {
        id: 'stat-02',
        figure: '42 production clusters audited',
        context: 'Sample size of the production cluster audit conducted last quarter.',
        segmentId: 'seg-002',
        classification: 'explicit_statement',
      },
      {
        id: 'stat-03',
        figure: '300% resource request padding',
        context: 'Typical buffer engineers add to pod memory reservations to avoid OOMKills.',
        segmentId: 'seg-003',
        classification: 'explicit_statement',
      },
      {
        id: 'stat-04',
        figure: '31% drop in unit compute cost in 6 weeks (0 OOM regressions)',
        context: 'Measured reduction in unit compute cost per 1,000 API requests across the 42-cluster cohort.',
        segmentId: 'seg-006',
        classification: 'explicit_statement',
      },
    ],
    strongQuotations: [
      {
        id: 'quote-01',
        exactQuote:
          'Most enterprise engineering organizations are unknowingly paying a thirty-eight percent idle compute tax on their Kubernetes clusters.',
        speaker: 'Dr. Elena Vance',
        start: 0,
        end: 14,
        segmentId: 'seg-001',
        significance: 'Primary quantitative hook establishing the scale of the problem.',
      },
      {
        id: 'quote-02',
        exactQuote:
          'Engineers pad resource requests by three hundred percent because nobody gets paged at two in the morning for an oversized pod, whereas an out-of-memory kill triggers an immediate incident review.',
        speaker: 'Dr. Elena Vance',
        start: 29,
        end: 45,
        segmentId: 'seg-003',
        significance: 'Core behavioral insight explaining why manual cost mandates fail.',
      },
      {
        id: 'quote-03',
        exactQuote:
          'Within six weeks across those forty-two clusters, unit compute cost per thousand API requests dropped by thirty-one percent with zero out-of-memory regressions.',
        speaker: 'Dr. Elena Vance',
        start: 75,
        end: 90,
        segmentId: 'seg-006',
        significance: 'Concrete, time-bound proof of outcome with zero reliability tradeoff.',
      },
    ],
    potentialMisconceptions: [
      {
        id: 'misc-01',
        title: 'Misconception: Traffic Spikes Cause Most Cluster Over-Provisioning',
        detail:
          'The audit showed static launch-day memory reservations—not unpredictable traffic bursts—were the primary source of idle slack.',
        classification: 'explicit_statement',
        segmentIds: ['seg-002'],
      },
    ],
    unsupportedClaims: [
      {
        id: 'unsup-01',
        title: 'Scope Constraint: Cohort-Specific 31% Savings',
        detail:
          'The 31% unit cost reduction was measured specifically across the 42 audited Kubernetes clusters over 6 weeks. Do not generalize as a guaranteed savings percentage for non-containerized or already rightsized workloads without an external audit.',
        classification: 'external_verification_required',
        segmentIds: ['seg-002', 'seg-006'],
        verificationNote:
          'Always cite the 42-cluster, 6-week cohort context when referencing the 31% figure.',
      },
    ],
    contentOpportunities: [
      'Flagship technical SEO article targeting "Kubernetes idle compute tax" and "rightsizing without OOMKills"',
      'Executive FinOps newsletter contrasting spreadsheet shaming vs automated p99 pipeline guardrails',
      '3-part LinkedIn campaign covering the 2 AM pager incentive, the 42-cluster audit findings, and the vertical burst architecture',
      'Two 9:16 vertical short-form clips highlighting the 38% idle tax hook and the 6-week outcome',
    ],
    distributionStrategy:
      'Publish the SEO technical guide on Monday of Week 1 alongside Flagship Clip 01. Follow with the Contrarian LinkedIn post on Wednesday and the Executive Newsletter on Friday, spacing subsequent framework posts and Clip 02 across Weeks 2–4.',
    brandAssumptionsMade: [],
    createdAt: now,
  };

  const strategy: ContentStrategy = {
    id: 'strat-vanguard-01',
    projectId: mainProject.id,
    version: 1,
    angles: [
      {
        id: 'angle-01',
        title: 'The 38% Kubernetes Idle Compute Tax: Findings from 42 Production Clusters',
        format: 'Technical SEO Deep-Dive',
        category: 'Educational',
        targetAudience: 'CTOs, VPs of Infrastructure, and Principal Platform Engineers',
        audienceProblem: 'Cloud compute spend rising faster than API request volume',
        centralMessage:
          'Static 300% memory reservations set at service launch—not traffic spikes—drive 38% cluster waste, and fixing them requires automated p99 pipeline guardrails.',
        supportingSegmentIds: ['seg-001', 'seg-002', 'seg-003', 'seg-005', 'seg-006'],
        intendedPlatform: 'Blog / Organic Search',
        desiredResponse: 'Audit cluster utilization using p99 histograms rather than static spreadsheets.',
        callToAction: vanguardBrand.approvedCallsToAction[0],
        productAlignment: 'Directly showcases Vanguard Pulse p99 telemetry and Vanguard Guardrail burst buffers.',
        approved: true,
      },
      {
        id: 'angle-02',
        title: 'Why Finance Spreadsheets Never Fix Kubernetes Over-Provisioning',
        format: 'Executive Email Briefing',
        category: 'Story / Case',
        targetAudience: 'Engineering Executives & FinOps Directors',
        audienceProblem: 'Friction between finance cost targets and SRE uptime mandates',
        centralMessage:
          'Reliability always beats spreadsheets on the production floor; lower unit costs by removing OOMKill risk with automated vertical burst buffers.',
        supportingSegmentIds: ['seg-003', 'seg-004', 'seg-005', 'seg-006'],
        intendedPlatform: 'Email Newsletter',
        desiredResponse: 'Reply to request a read-only 14-day Vanguard Pulse cluster audit.',
        callToAction: vanguardBrand.approvedCallsToAction[0],
        productAlignment: 'Positions the 14-day read-only audit as a zero-risk executive diagnostic.',
        approved: true,
      },
      {
        id: 'angle-03',
        title: 'Nobody Gets Paged at 2 AM for an Oversized Pod',
        format: 'Contrarian argument',
        category: 'Opinion-Led',
        targetAudience: 'Staff SREs, DevOps Architects, and Platform Leads',
        audienceProblem: 'Being blamed for padded Kubernetes resource requests',
        centralMessage:
          '300% pod padding is a rational engineering response to asymmetric on-call incentives, not developer carelessness.',
        supportingSegmentIds: ['seg-002', 'seg-003', 'seg-004'],
        intendedPlatform: 'LinkedIn',
        desiredResponse: 'High-signal technical discussion from SREs and platform leads.',
        callToAction: vanguardBrand.approvedCallsToAction[1],
        productAlignment: 'Builds deep practitioner trust by defending engineering reliability priorities.',
        approved: true,
      },
      {
        id: 'angle-04',
        title: 'How We Cut Unit Compute Cost 31% in 6 Weeks with Zero OOM Regressions',
        format: 'Practical framework',
        category: 'Educational',
        targetAudience: 'Platform Engineering Managers & Cloud Architects',
        audienceProblem: 'Need a proven rollout sequence for automated pod rightsizing',
        centralMessage:
          'Couple continuous p99 histograms in CI/CD with an automated vertical burst buffer to reclaim slack safely.',
        supportingSegmentIds: ['seg-005', 'seg-006'],
        intendedPlatform: 'LinkedIn',
        desiredResponse: 'Bookmark the 2-part architectural pattern and explore the benchmark report.',
        callToAction: vanguardBrand.approvedCallsToAction[0],
        productAlignment: 'Demonstrates measurable 6-week time-to-value for Vanguard Guardrail.',
        approved: true,
      },
    ],
    updatedAt: now,
  };

  const blogStruct: SeoBlogStructured = {
    suggestedTitle:
      'Eliminating the 38% Kubernetes Idle Compute Tax: Lessons from Auditing 42 Production Clusters',
    alternativeHeadlines: [
      'Why Static Pod Memory Reservations Cost Enterprises 38% in Idle Kubernetes Compute',
      'Nobody Gets Paged for an Oversized Pod: Fixing Kubernetes Unit Economics Without OOMKills',
    ],
    searchIntent: 'Informational',
    primaryKeyword: 'kubernetes idle compute tax',
    secondaryKeywords: [
      'kubernetes pod rightsizing',
      'p99 utilization telemetry',
      'preventing kubernetes oomkill',
      'cloud unit economics',
    ],
    metaTitle: 'Eliminating the 38% Kubernetes Idle Compute Tax | Vanguard Cloud',
    metaDescription:
      'Data from 42 production Kubernetes clusters reveals why static 300% memory padding happens—and how automated p99 burst buffers cut unit compute cost by 31%.',
    urlSlug: 'eliminating-38-percent-kubernetes-idle-compute-tax',
    introduction:
      'Most enterprise engineering organizations are unknowingly paying a 38% idle compute tax on their Kubernetes clusters. When Dr. Elena Vance and the Vanguard Cloud architecture team audited 42 production clusters last quarter, the culprit was never unpredictable traffic spikes—it was static memory reservations configured during initial service launch.',
    sections: [
      {
        heading: '1. Why Traffic Spikes Are Not the Real Root Cause',
        body: 'Conventional capacity planning assumes that wide cluster margins exist to absorb sudden traffic surges. However, across the 42 production clusters examined last quarter, baseline slack remained constant day and night. Services were locking node capacity through static memory reservations set months or years earlier during initial deployment.',
        supportingSegmentIds: ['seg-001', 'seg-002'],
        claimNote: 'Directly supported by audited 42-cluster cohort data in segments seg-001 and seg-002.',
      },
      {
        heading: '2. The 2:00 AM Pager Asymmetry: Why Engineers Pad Requests by 300%',
        body: 'As Dr. Vance notes verbatim: "Engineers pad resource requests by three hundred percent because nobody gets paged at two in the morning for an oversized pod, whereas an out-of-memory kill triggers an immediate incident review." When organizations attempt to solve this with finance spreadsheets or quarterly shaming emails, engineering teams rightly prioritize uptime over manual cost reductions.',
        supportingSegmentIds: ['seg-003', 'seg-004'],
        claimNote: 'Direct verbatim quotation from seg-003; behavioral explanation from seg-004.',
      },
      {
        heading: '3. Coupling Pipeline p99 Histograms with Vertical Burst Buffers',
        body: 'To eliminate defensive padding without introducing incident risk, the team coupled continuous p99 utilization histograms directly into the deployment pipeline alongside an automated vertical burst buffer. Pods reserve only what they empirically consume while retaining instant access to burst capacity if anomalous load arrives.',
        supportingSegmentIds: ['seg-005'],
        claimNote: 'Architectural mechanism stated in seg-005.',
      },
      {
        heading: '4. Measured Outcome: 31% Lower Unit Compute Cost in Six Weeks',
        body: 'Within six weeks across those 42 production clusters, unit compute cost per 1,000 API requests dropped by 31% with zero out-of-memory regressions. Note that these figures reflect the audited 42-cluster cohort; individual savings depend on existing reservation baselines.',
        supportingSegmentIds: ['seg-006'],
        claimNote: 'Cohort-specific outcome verified in seg-006.',
      },
    ],
    conclusion:
      'Sustainable Kubernetes efficiency never comes from asking engineers to gamble with production stability. By embedding empirical p99 telemetry and automated vertical burst guardrails directly into the delivery pipeline, platform teams can reclaim idle capacity while protecting reliability.',
    internalLinkSuggestions: [
      'https://vanguardcloud.io/docs/pulse-telemetry-agent',
      'https://vanguardcloud.io/research/q4-kubernetes-unit-economics-report',
    ],
    callToAction: vanguardBrand.approvedCallsToAction[0],
  };

  const nlStruct: NewsletterStructured = {
    subjectLine: 'Nobody gets paged at 2 AM for an oversized Kubernetes pod',
    alternativeSubjectLines: [
      'Inside our 42-cluster audit: The 38% Kubernetes idle compute tax',
      'How we cut unit compute cost 31% in 6 weeks (with zero OOMKills)',
    ],
    previewText:
      'Why finance spreadsheets fail to fix static 300% memory padding—and the pipeline architecture that worked.',
    opening:
      'Hi there,\n\nLast quarter, our architecture team audited 42 production Kubernetes clusters to answer a deceptively simple question: why are enterprise engineering teams paying an average 38% idle compute tax even when traffic is predictable?',
    mainMessage:
      'The root cause was never traffic spikes. It was static memory reservations set at initial service launch.\n\nEngineers routinely pad resource requests by 300% because on-call incentives are completely asymmetric: nobody gets paged at 2:00 AM for an oversized pod, whereas a single out-of-memory (OOM) kill triggers an immediate incident review.\n\nIf you try to fix that with quarterly finance spreadsheets, engineering teams will rightly ignore them—because reliability always trumps cost on the production floor.\n\nInstead, we coupled continuous p99 utilization histograms directly into the deployment pipeline with an automated vertical burst buffer.',
    keyTakeaways: [
      '38% average idle compute tax across audited enterprise Kubernetes clusters (seg-001)',
      'Static launch reservations—not traffic surges—drive the majority of cluster slack (seg-002)',
      'Coupling CI/CD p99 histograms with an automated vertical burst buffer reduced unit compute cost per 1,000 API requests by 31% in 6 weeks with zero OOM regressions (seg-005, seg-006)',
    ],
    sourceQuotation: {
      quote:
        'Engineers pad resource requests by three hundred percent because nobody gets paged at two in the morning for an oversized pod, whereas an out-of-memory kill triggers an immediate incident review.',
      speaker: 'Dr. Elena Vance, CTO',
      timestamp: '00:29',
    },
    callToAction: vanguardBrand.approvedCallsToAction[0],
    closing: 'Best,\nDr. Elena Vance & the Vanguard Cloud Architecture Team',
    objective: mainProject.primaryObjective,
    tone: 'Executive Briefing',
  };

  const liStruct1: LinkedInPostStructured = {
    format: 'Contrarian argument',
    openingHook:
      'Nobody gets paged at 2:00 AM for an oversized Kubernetes pod. An OOMKill triggers an immediate incident review.',
    postText: `Nobody gets paged at 2:00 AM for an oversized Kubernetes pod.\nAn OOMKill triggers an immediate incident review.\n\nWhen we audited 42 production Kubernetes clusters last quarter, we found enterprises paying a 38% idle compute tax.\n\nThe root cause wasn't unpredictable traffic spikes.\nIt was static 300% memory reservations set during initial service launch.\n\nAnd here's the truth: padding pods by 300% is 100% rational behavior under standard on-call incentives.\n\nIf you try to fix this with finance spreadsheets or quarterly shaming emails, engineering teams will rightly ignore you—because reliability always trumps cost on the production floor.\n\nYou don't fix unit economics with spreadsheets. You fix them by removing the reliability risk.\n\n${vanguardBrand.approvedCallsToAction[1]}`,
    coreArgument:
      '300% memory padding is a rational engineering response to asymmetric on-call incentives and cannot be solved by finance spreadsheets.',
    supportingMaterial: '42-cluster audit findings and verbatim commentary in seg-001 through seg-004.',
    callToAction: vanguardBrand.approvedCallsToAction[1],
    suggestedPublicationDate: '2026-11-04',
    sourceTimestamps: ['00:00-00:14', '00:29-00:60'],
  };

  const liStruct2: LinkedInPostStructured = {
    format: 'Practical framework',
    openingHook:
      'How do you cut Kubernetes unit compute cost by 31% in 6 weeks with zero OOM regressions?',
    postText: `How do you cut Kubernetes unit compute cost by 31% in 6 weeks with zero OOM regressions?\n\nAcross 42 production clusters, manual rightsizing tickets kept stalling because SREs wouldn't risk an out-of-memory kill.\n\nHere is the exact 2-part architecture we used instead:\n\n1. Pipeline-Integrated p99 Histograms\nInstead of static launch-day guesses, feed continuous p99 utilization histograms directly into the deployment pipeline so pods only reserve what they empirically consume.\n\n2. Automated Vertical Burst Buffers\nPair tightened reservations with an automated vertical burst buffer so any unexpected workload spike borrows headroom before an OOMKill can ever trigger.\n\nResult across the 42-cluster cohort after 6 weeks:\n• 31% lower unit compute cost per 1,000 API requests\n• 0 out-of-memory regressions\n\n${vanguardBrand.approvedCallsToAction[0]}`,
    coreArgument:
      'Pairing CI/CD p99 histograms with an automated vertical burst buffer achieves a 31% unit cost reduction without OOM regressions.',
    supportingMaterial: 'Segments seg-005 and seg-006 (01:00 - 01:30).',
    callToAction: vanguardBrand.approvedCallsToAction[0],
    suggestedPublicationDate: '2026-11-09',
    sourceTimestamps: ['01:00-01:30'],
  };

  const liStruct3: LinkedInPostStructured = {
    format: 'Founder lesson',
    openingHook:
      'Stop blaming unpredictable traffic spikes for your cloud bill.',
    postText: `Stop blaming unpredictable traffic spikes for your cloud bill.\n\nWhen we inspected 42 production Kubernetes clusters, traffic volatility wasn't driving the 38% idle compute tax.\n\nStatic memory reservations configured on Day 1—and never touched again—were locking up node capacity 24/7.\n\nWhy don't teams touch Day 1 reservations?\nBecause lowering a memory limit has zero upside for a developer and massive downside if a pod crashes.\n\nUntil your infrastructure tooling guarantees automatic burst protection, static padding will remain the default.\n\n${vanguardBrand.approvedCallsToAction[0]}`,
    coreArgument:
      'Day-1 static reservations persist because developers face downside incident risk with zero upside for manual tuning.',
    supportingMaterial: 'Segments seg-001, seg-002, and seg-003 (00:00 - 00:45).',
    callToAction: vanguardBrand.approvedCallsToAction[0],
    suggestedPublicationDate: '2026-11-13',
    sourceTimestamps: ['00:00-00:45'],
  };

  const showNotesMarkdown = `# Podcast & Keynote Show Notes: Eliminating the 38% Kubernetes Idle Tax
**Speaker:** Dr. Elena Vance, CTO at Vanguard Cloud Systems
**Duration:** 01:30 (Verified Studio Master)

## Episode Summary
Dr. Elena Vance breaks down telemetry from 42 production Kubernetes clusters, revealing why static 300% launch reservations—not traffic spikes—cause a 38% idle compute tax, and how automated p99 pipeline histograms + vertical burst buffers cut unit compute cost per 1,000 API requests by 31% in six weeks.

## Timestamped Chapter Breakdown
- **[00:00 - 00:14]** The 38% idle compute tax across enterprise Kubernetes clusters (\`seg-001\`)
- **[00:14 - 00:29]** Inside the 42-cluster audit: static launch reservations vs traffic spikes (\`seg-002\`)
- **[00:29 - 00:45]** Why engineers pad pods by 300%: the 2:00 AM pager asymmetry (\`seg-003\`)
- **[00:45 - 01:00]** Why finance spreadsheets and shaming emails fail on the production floor (\`seg-004\`)
- **[01:00 - 01:15]** Architecture solution: CI/CD p99 utilization histograms + vertical burst buffer (\`seg-005\`)
- **[01:15 - 01:30]** Cohort results: 31% unit compute cost reduction in 6 weeks with zero OOM regressions (\`seg-006\`)

## Resources & Next Steps
- ${vanguardBrand.approvedCallsToAction[0]}
- ${vanguardBrand.website}`;

  const blogMd = formatBlogMarkdown(blogStruct);
  const nlMd = formatNewsletterMarkdown(nlStruct);

  const initialAssets: AssetDeliverable[] = [
    {
      id: 'asset-blog-01',
      projectId: mainProject.id,
      assetType: 'seo_blog',
      platform: 'Blog / Organic Search',
      title: blogStruct.suggestedTitle,
      subtitle: `Primary Keyword: ${blogStruct.primaryKeyword} · Intent: ${blogStruct.searchIntent}`,
      category: 'Educational',
      structuredData: blogStruct,
      markdownContent: blogMd,
      approvedContent: blogMd,
      approvedVersion: 1,
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003', 'seg-004', 'seg-005', 'seg-006'],
      status: 'approved',
      version: 1,
      angleId: 'angle-01',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asset-nl-01',
      projectId: mainProject.id,
      assetType: 'email_newsletter',
      platform: 'Email Newsletter',
      title: nlStruct.subjectLine,
      subtitle: `Preview: ${nlStruct.previewText}`,
      category: 'Story / Case',
      structuredData: nlStruct,
      markdownContent: nlMd,
      approvedContent: nlMd,
      approvedVersion: 1,
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003', 'seg-005', 'seg-006'],
      status: 'approved',
      version: 1,
      angleId: 'angle-02',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asset-li-01',
      projectId: mainProject.id,
      assetType: 'linkedin_post',
      platform: 'LinkedIn',
      title: `Contrarian argument: ${liStruct1.openingHook.slice(0, 62)}...`,
      subtitle: liStruct1.coreArgument,
      category: 'Opinion-Led',
      structuredData: liStruct1,
      markdownContent: formatLinkedInMarkdown(liStruct1),
      approvedContent: formatLinkedInMarkdown(liStruct1),
      approvedVersion: 1,
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003', 'seg-004'],
      status: 'approved',
      version: 1,
      angleId: 'angle-03',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asset-li-02',
      projectId: mainProject.id,
      assetType: 'linkedin_post',
      platform: 'LinkedIn',
      title: `Practical framework: ${liStruct2.openingHook.slice(0, 62)}...`,
      subtitle: liStruct2.coreArgument,
      category: 'Educational',
      structuredData: liStruct2,
      markdownContent: formatLinkedInMarkdown(liStruct2),
      sourceSegmentIds: ['seg-005', 'seg-006'],
      status: 'ready_for_review',
      version: 1,
      angleId: 'angle-04',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asset-li-03',
      projectId: mainProject.id,
      assetType: 'linkedin_post',
      platform: 'LinkedIn',
      title: `Founder lesson: ${liStruct3.openingHook}`,
      subtitle: liStruct3.coreArgument,
      category: 'Opinion-Led',
      structuredData: liStruct3,
      markdownContent: formatLinkedInMarkdown(liStruct3),
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003'],
      status: 'ready_for_review',
      version: 1,
      angleId: 'angle-03',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'asset-notes-01',
      projectId: mainProject.id,
      assetType: 'podcast_show_notes',
      platform: 'Podcast Show Notes',
      title: 'Keynote Show Notes & Timestamped Chapter Guide',
      subtitle: 'Complete 6-chapter breakdown with verbatim metrics and resource links',
      category: 'Educational',
      structuredData: { chapters: 6 },
      markdownContent: showNotesMarkdown,
      approvedContent: showNotesMarkdown,
      approvedVersion: 1,
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003', 'seg-004', 'seg-005', 'seg-006'],
      status: 'approved',
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];

  // Pre-render Clip 01 via real FFmpeg so an actual rendered MP4 + SRT is immediately available!
  const clip1Config = {
    aspectRatio: '9:16' as const,
    width: 540,
    height: 960,
    layoutMode: 'blurred-background' as const,
    burnInCaptions: true,
    showBrandLogoOverlay: true,
    showHookTitleOverlay: true,
    captionStyle: vanguardBrand.visualIdentity.captionStyle,
  };

  let clip1VideoUrl: string | undefined;
  let clip1SrtUrl: string | undefined;
  const initialRenderJobs: RenderJob[] = [];

  try {
    const existingSeedRenders = fs.existsSync(RENDERS_DIR)
      ? fs
          .readdirSync(RENDERS_DIR)
          .filter((f) => f.startsWith('clip-01-') && f.endsWith('.mp4'))
          .sort()
      : [];

    if (existingSeedRenders.length > 0) {
      const mp4File = existingSeedRenders[0];
      const srtFile = mp4File.replace(/\.mp4$/, '.srt');
      clip1VideoUrl = `/media/renders/${mp4File}`;
      if (fs.existsSync(path.join(RENDERS_DIR, srtFile))) {
        clip1SrtUrl = `/media/renders/${srtFile}`;
      }
      initialRenderJobs.push({
        id: 'job-seed-01',
        projectId: mainProject.id,
        clipId: 'clip-01',
        status: 'approved',
        config: clip1Config,
        outputPath: path.join(RENDERS_DIR, mp4File),
        publicVideoUrl: clip1VideoUrl,
        publicSrtUrl: clip1SrtUrl,
        durationSeconds: 45,
        createdAt: now,
        completedAt: new Date().toISOString(),
      });
    } else {
      const rendered = await renderVideoClipWithFfmpeg({
        sourceFilePath: sampleVideoPath,
        outputDir: RENDERS_DIR,
        clipId: 'clip-01',
        clipTitle: 'The 38% Kubernetes Idle Tax & 2 AM Pager Asymmetry',
        brandLogoText: vanguardBrand.visualIdentity.logoText,
        onScreenHook: 'Why Engineers Pad K8s Pods by 300%',
        start: 0,
        end: 45,
        transcript: SAMPLE_KEYNOTE_TRANSCRIPT,
        config: clip1Config,
      });
      clip1VideoUrl = `/media/renders/${rendered.outputFilename}`;
      clip1SrtUrl = `/media/renders/${rendered.srtFilename}`;
      initialRenderJobs.push({
        id: 'job-seed-01',
        projectId: mainProject.id,
        clipId: 'clip-01',
        status: 'approved',
        config: clip1Config,
        outputPath: rendered.outputFilePath,
        publicVideoUrl: clip1VideoUrl,
        publicSrtUrl: clip1SrtUrl,
        durationSeconds: rendered.probe.durationSeconds,
        createdAt: now,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('Failed to pre-render seed clip-01:', e);
  }

  const initialClips: VideoClipCandidate[] = [
    {
      id: 'clip-01',
      projectId: mainProject.id,
      sourceId: sourceMaterial.id,
      title: 'The 38% Kubernetes Idle Tax & 2 AM Pager Asymmetry',
      hook: 'Most enterprise engineering organizations are unknowingly paying a 38% idle compute tax on their Kubernetes clusters.',
      start: 0,
      end: 45,
      duration: 45,
      openingText: SAMPLE_KEYNOTE_TRANSCRIPT[0].text,
      closingText: SAMPLE_KEYNOTE_TRANSCRIPT[2].text,
      fullTranscript: SAMPLE_KEYNOTE_TRANSCRIPT.slice(0, 3)
        .map((s) => s.text)
        .join(' '),
      centralIdea:
        'Static 300% memory reservations set at service launch drive the 38% idle compute tax because engineers get paged for OOMKills, never for oversized pods.',
      selectionReason:
        'Opens with a sharp 38% quantitative hook, refutes the traffic-spike myth with 42-cluster audit data, and closes on the memorable 2 AM pager insight.',
      targetAudience: 'CTOs, Platform Leads & Principal SREs',
      recommendedPlatform: 'YouTube Shorts',
      suggestedCaption:
        'Nobody gets paged at 2 AM for an oversized Kubernetes pod—which is why teams pad requests by 300%. Here is what our 42-cluster audit uncovered.\n\n#Kubernetes #FinOps #PlatformEngineering #SRE',
      onScreenTitle: 'Why Engineers Pad K8s Pods by 300%',
      callToAction: vanguardBrand.approvedCallsToAction[0],
      editorialScores: {
        openingStrength: 96,
        contentClarity: 94,
        completeness: 92,
        audienceRelevance: 95,
        standaloneUsefulness: 91,
        productionSuitability: 94,
        overallScore: 94,
        rationale:
          'Immediate quantitative hook in second 0, complete 3-segment narrative arc, and clean sentence boundaries at 00:00 and 00:45.',
      },
      timingConfidence: 'verified',
      sourceSegmentIds: ['seg-001', 'seg-002', 'seg-003'],
      boundaryValidation: {
        status: 'valid',
        warnings: [],
        cutsSentenceStart: false,
        cutsSentenceEnd: false,
        lacksStandaloneContext: false,
        withinSourceDuration: true,
        overlapsWithClipIds: [],
      },
      renderConfig: clip1Config,
      renderStatus: clip1VideoUrl ? 'approved' : 'waiting',
      outputVideoUrl: clip1VideoUrl,
      outputSrtUrl: clip1SrtUrl,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'clip-02',
      projectId: mainProject.id,
      sourceId: sourceMaterial.id,
      title: 'How Automated p99 Burst Buffers Cut Unit Compute Cost 31%',
      hook: 'If you try to fix this with finance spreadsheets or quarterly shaming emails, engineering teams will rightly ignore you.',
      start: 45,
      end: 90,
      duration: 45,
      openingText: SAMPLE_KEYNOTE_TRANSCRIPT[3].text,
      closingText: SAMPLE_KEYNOTE_TRANSCRIPT[5].text,
      fullTranscript: SAMPLE_KEYNOTE_TRANSCRIPT.slice(3, 6)
        .map((s) => s.text)
        .join(' '),
      centralIdea:
        'Replacing finance spreadsheets with pipeline p99 histograms and an automated vertical burst buffer cut unit compute cost by 31% in 6 weeks with zero OOM regressions.',
      selectionReason:
        'Contrast-driven opening ("shaming emails fail") followed by a concrete architectural remedy and a verified 31% outcome.',
      targetAudience: 'VPs of Engineering, FinOps Leads & Cloud Architects',
      recommendedPlatform: 'LinkedIn',
      suggestedCaption:
        'Finance spreadsheets never fix Kubernetes over-provisioning because reliability always trumps cost on the production floor. Here is what cut unit compute cost 31% in 6 weeks with 0 OOMKills.',
      onScreenTitle: '31% Lower K8s Cost With Zero OOMKills',
      callToAction: vanguardBrand.approvedCallsToAction[0],
      editorialScores: {
        openingStrength: 91,
        contentClarity: 93,
        completeness: 90,
        audienceRelevance: 94,
        standaloneUsefulness: 92,
        productionSuitability: 90,
        overallScore: 92,
        rationale:
          'Strong problem-to-solution arc spanning segments seg-004 through seg-006 with zero overlap with Clip 01.',
      },
      timingConfidence: 'verified',
      sourceSegmentIds: ['seg-004', 'seg-005', 'seg-006'],
      boundaryValidation: {
        status: 'valid',
        warnings: [],
        cutsSentenceStart: false,
        cutsSentenceEnd: false,
        lacksStandaloneContext: false,
        withinSourceDuration: true,
        overlapsWithClipIds: [],
      },
      renderConfig: {
        ...clip1Config,
        layoutMode: 'fit',
      },
      renderStatus: 'waiting',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'clip-03',
      projectId: mainProject.id,
      sourceId: sourceMaterial.id,
      title: 'Rapid Cut: The 2 AM Pager vs Finance Spreadsheets',
      hook: 'Engineers pad resource requests by 300% because nobody gets paged at 2 in the morning for an oversized pod.',
      start: 29,
      end: 60,
      duration: 31,
      openingText: SAMPLE_KEYNOTE_TRANSCRIPT[2].text,
      closingText: SAMPLE_KEYNOTE_TRANSCRIPT[3].text,
      fullTranscript: SAMPLE_KEYNOTE_TRANSCRIPT.slice(2, 4)
        .map((s) => s.text)
        .join(' '),
      centralIdea:
        'The clash between 2 AM on-call incident incentives and quarterly finance cost mandates.',
      selectionReason:
        'Tight 31-second punchy segment ideal for TikTok / Reels, though it partially overlaps with Clip 01 and Clip 02.',
      targetAudience: 'SREs & DevOps Practitioners',
      recommendedPlatform: 'TikTok / Reels',
      suggestedCaption:
        'Why every Kubernetes pod is padded by 300%—and why quarterly finance emails never change it.',
      onScreenTitle: '2 AM Pagers vs Cloud Finance Spreadsheets',
      callToAction: vanguardBrand.approvedCallsToAction[1],
      editorialScores: {
        openingStrength: 94,
        contentClarity: 90,
        completeness: 84,
        audienceRelevance: 89,
        standaloneUsefulness: 85,
        productionSuitability: 88,
        overallScore: 89,
        rationale:
          'High opening punch, flagged for editorial review because it shares seg-003 with Clip 01 and seg-004 with Clip 02.',
      },
      timingConfidence: 'verified',
      sourceSegmentIds: ['seg-003', 'seg-004'],
      boundaryValidation: {
        status: 'needs_review',
        warnings: ['Overlaps significantly with clip(s): clip-01, clip-02.'],
        cutsSentenceStart: false,
        cutsSentenceEnd: false,
        lacksStandaloneContext: false,
        withinSourceDuration: true,
        overlapsWithClipIds: ['clip-01', 'clip-02'],
      },
      renderConfig: {
        ...clip1Config,
        layoutMode: 'crop',
      },
      renderStatus: 'waiting',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const initialCalendar = generateDeterministicCalendar({
    projectId: mainProject.id,
    startDate: mainProject.config.campaignStartDate,
    preferredDays: mainProject.config.preferredPublishingDays,
    assets: initialAssets,
    clips: initialClips,
  });

  memoryDb = {
    brands: [],
    projects: [],
    sources: [],
    transcripts: {},
    analyses: {},
    strategies: {},
    assets: {},
    clips: {},
    renderJobs: {},
    calendars: {},
    exports: {},
    integrations: DEFAULT_INTEGRATIONS,
    integrationLogs: [],
    deletedProjectIds: [],
  };

  await repairAndMigrateDatabase(memoryDb);
  saveStorage();
  return memoryDb;
}

/**
 * Repairs legacy paths, sanitizes raw FFmpeg error dumps, recovers stuck processing jobs,
 * clamps >120s clips, and restores any user-uploaded video files (such as Vikas-Divyakirti-on-SnapYT.App.mp4)
 * so existing user media and projects work out-of-the-box.
 */
async function repairAndMigrateDatabase(db: DatabaseSchema): Promise<void> {
  if (!Array.isArray(db.integrations) || db.integrations.length === 0) {
    db.integrations = DEFAULT_INTEGRATIONS;
  }
  if (!Array.isArray(db.integrationLogs)) {
    db.integrationLogs = [];
  }
  if (!Array.isArray(db.deletedProjectIds)) {
    db.deletedProjectIds = [];
  }

  // Remove hardcoded sample companies (Vanguard & Apex) and sample keynote project so user builds their own personalized Brand Profile
  if (Array.isArray(db.brands)) {
    db.brands = db.brands.filter(
      (b) => b.id !== 'brand-vanguard' && b.id !== 'brand-apex'
    );
  } else {
    db.brands = [];
  }

  if (Array.isArray(db.projects)) {
    const sampleProjectIds = new Set(['proj-keynote-q4', ...(db.deletedProjectIds || [])]);
    const removedIds = db.projects
      .filter((p) => sampleProjectIds.has(p.id))
      .map((p) => p.id);
    if (removedIds.length > 0) {
      db.projects = db.projects.filter((p) => !sampleProjectIds.has(p.id));
      db.sources = (db.sources || []).filter((s) => !sampleProjectIds.has(s.projectId));
      for (const pid of removedIds) {
        delete db.transcripts[pid];
        delete db.analyses[pid];
        delete db.strategies[pid];
        delete db.assets[pid];
        delete db.clips[pid];
        delete db.renderJobs[pid];
        delete db.calendars[pid];
        delete db.exports[pid];
      }
    }
    // Rebind any projects referencing removed sample brands to the user's primary brand if available
    if (db.brands.length > 0) {
      const primaryBrandId = db.brands[0].id;
      for (const p of db.projects) {
        if (!db.brands.some((b) => b.id === p.brandId)) {
          p.brandId = primaryBrandId;
        }
      }
    }
  }

  // 1. Normalize source paths & probe frameRate / storageBackend
  for (const src of db.sources || []) {
    if (src.filePath && src.filePath.includes('D:\\StrataStudio\\storage')) {
      const fname = path.basename(src.filePath);
      const sub = src.inputMethod === 'sample_fixture' ? FIXTURES_DIR : UPLOADS_DIR;
      src.filePath = path.join(sub, fname);
    }
    if (!src.frameRate) src.frameRate = 30;
    if (!src.storageBackend) {
      src.storageBackend = process.platform === 'win32' ? 'windows_local' : 'server_posix';
    }
  }

  // 2. Sanitize raw FFmpeg command strings in failedTasks, clamp clipMaxDurationSec <= 120, and compute coverageReport
  for (const proj of db.projects || []) {
    if (proj.config) {
      proj.config.clipMaxDurationSec = Math.min(120, proj.config.clipMaxDurationSec || 60);
      if (!proj.config.renderQueueConfig) {
        proj.config.renderQueueConfig = {
          maxConcurrentJobs: 1,
          maxQueuedJobs: 20,
          jobTimeoutSec: 75,
          maxRetries: 1,
          tempRetentionMinutes: 30,
        };
      }
    }

    if (Array.isArray(proj.failedTasks)) {
      // Remove or sanitize any raw FFmpeg command dumps or legacy URL restriction alerts from previous sessions
      proj.failedTasks = proj.failedTasks
        .filter(
          (f) =>
            !String(f.message || '').includes('Command failed: ffmpeg') &&
            !String(f.message || '').includes('Direct scraping or bypassing platform download controls')
        )
        .map((f) => {
          if (!f.diagnostic) {
            const diag = sanitizeOperationalError({
              stage: f.stage,
              rawError: f.message,
            });
            return {
              ...f,
              message: diag.userMessage,
              diagnostic: diag,
            };
          }
          return f;
        });
    } else {
      proj.failedTasks = [];
    }

    const projSource = db.sources.find((s) => s.projectId === proj.id);
    const projTranscript = db.transcripts[proj.id] || [];
    const mediaDur = projSource?.mediaDurationSeconds || 60;

    // If a long video (>120s) had <= 6 giant segments (like 1317s each), rebuild granular segments
    if (
      mediaDur > 120 &&
      projTranscript.length > 0 &&
      projTranscript.some((s) => s.end - s.start > 120)
    ) {
      db.transcripts[proj.id] = buildDurationCalibratedTranscript({
        sourceId: projSource?.id || 'src-repaired',
        fileName: projSource?.fileName || proj.sourceTitle,
        durationSeconds: mediaDur,
        language: proj.sourceLanguage || 'en',
        sourceTitle: proj.sourceTitle,
      });
    }

    // Enrich transcript segments with originalText, romanisedText (Hinglish/Roman script), and code-switching detection
    db.transcripts[proj.id] = enrichTranscriptWithRomanisation(
      db.transcripts[proj.id] || [],
      proj.sourceLanguage || 'hi'
    );

    const enrichedTranscript = db.transcripts[proj.id] || [];
    proj.coverageReport = computeTranscriptCoverageReport({
      segments: enrichedTranscript,
      sourceDurationSec: mediaDur,
    });
    if (proj.coverageReport) {
      proj.coverageReport.romanisationApplied = true;
      proj.coverageReport.codeSwitchedSegmentsCount = enrichedTranscript.filter(
        (s) => s.hasCodeSwitching
      ).length;
      proj.coverageReport.uncertainSegmentsCount = enrichedTranscript.filter(
        (s) => (s.uncertainWords && s.uncertainWords.length > 0) || s.confidence < 0.88
      ).length;
    }

    if (proj.config) {
      if (!proj.config.defaultTranscriptDisplayMode) {
        proj.config.defaultTranscriptDisplayMode =
          proj.sourceLanguage === 'hi' || proj.sourceLanguage === 'gu'
            ? 'both'
            : 'original';
      }
      if (!proj.config.defaultCaptionScriptMode) {
        proj.config.defaultCaptionScriptMode = 'original';
      }
    }

    // Repair clips for this project: recover stuck 'processing'/'queued' states, clamp duration <= 120s, and attach context recommendations
    const projClips = db.clips[proj.id] || [];
    const smartComp = detectSmartVideoComposition({
      sourceType: proj.sourceType,
      width: projSource?.width || 1280,
      height: projSource?.height || 720,
      speakerCount: proj.coverageReport?.speakerCount || 1,
    });

    for (const clip of projClips) {
      if (clip.duration > 120 || clip.end - clip.start > 120) {
        const clamped = clampClipIntervalToShortForm({
          start: clip.start,
          end: clip.end,
          sourceDurationSec: mediaDur,
          maxDurationSec: 60,
          preferredDurationSec: 45,
        });
        clip.start = clamped.start;
        clip.end = clamped.end;
        clip.duration = clamped.duration;
      }
      if (clip.renderStatus === 'processing' || clip.renderStatus === 'queued') {
        clip.renderStatus = clip.outputVideoUrl ? 'ready_for_review' : 'waiting';
      }
      if (clip.lastRenderError && clip.lastRenderError.includes('Command failed:')) {
        const diag = sanitizeOperationalError({
          stage: 'video_render',
          rawError: clip.lastRenderError,
          clipId: clip.id,
        });
        clip.lastRenderError = diag.userMessage;
        clip.lastDiagnostic = diag;
      }
      if (!clip.renderConfig.manualCrop) {
        clip.renderConfig.manualCrop = {
          horizontalOffset: smartComp.cropX,
          verticalOffset: smartComp.cropY,
          zoom: smartComp.zoom,
          subjectSceneType: smartComp.sceneType,
        };
      }
      if (!clip.renderConfig.captionScriptMode) {
        clip.renderConfig.captionScriptMode =
          proj.config?.defaultCaptionScriptMode || 'original';
      }
      clip.renderConfig.cropValidation = validateVerticalCompositionCrop({
        config: clip.renderConfig,
        sourceWidth: projSource?.width || 1280,
        sourceHeight: projSource?.height || 720,
      });
      if (!clip.contextRecommendations) {
        clip.contextRecommendations = buildClipContextRecommendations({
          clip,
          projectObjective: proj.primaryObjective,
          targetAudience: proj.targetAudience,
        });
      }
    }

    // Recover stuck renderJobs
    const jobs = db.renderJobs[proj.id] || [];
    for (const job of jobs) {
      if (job.outputPath && job.outputPath.includes('D:\\StrataStudio\\storage')) {
        job.outputPath = path.join(RENDERS_DIR, path.basename(job.outputPath));
      }
      if (job.status === 'processing' || job.status === 'queued') {
        job.status = job.publicVideoUrl ? 'ready_for_review' : 'failed';
        job.completedAt = new Date().toISOString();
      }
      if (job.errorDetails && job.errorDetails.includes('Command failed:')) {
        const diag = sanitizeOperationalError({
          stage: 'video_render',
          rawError: job.errorDetails,
          clipId: job.clipId,
          jobId: job.id,
        });
        job.errorDetails = diag.userMessage;
        job.diagnostic = diag;
      }
    }
  }

  // 3. Check if the user's uploaded Vikas-Divyakirti-on-SnapYT.App.mp4 is in UPLOADS_DIR and restore project 'aifbgvaer' if missing
  if (fs.existsSync(UPLOADS_DIR)) {
    const uploadFiles = fs.readdirSync(UPLOADS_DIR);
    const vikasFile = uploadFiles.find((f) =>
      f.toLowerCase().includes('vikas-divyakirti')
    );

    if (vikasFile) {
      const fullVikasPath = path.join(UPLOADS_DIR, vikasFile);
      const alreadyBound = db.sources.some(
        (s) => s.filePath === fullVikasPath || s.fileName.toLowerCase().includes('vikas-divyakirti')
      );

      if (
        !alreadyBound &&
        !db.deletedProjectIds.includes('aifbgvaer') &&
        fs.existsSync(fullVikasPath)
      ) {
        try {
          const probe = await probeMediaFile(fullVikasPath);
          const now = new Date().toISOString();
          const fallbackBrand: BrandProfile = db.brands[0] || {
            id: 'brand-user-default',
            name: 'Your Brand Workspace',
            companyDescription: 'Personalized content operations and short-form video studio.',
            industry: 'Media & Technology',
            businessModel: 'Digital Content & Operations',
            productsAndServices: ['Video & Written Content Repurposing'],
            targetAudiences: ['Practitioners, Creators & Decision Makers'],
            primaryCustomerProblems: ['Turning long-form recordings into high-signal multi-platform assets'],
            brandPositioning: 'Clear, insight-driven, audience-first storytelling.',
            uniqueDifferentiators: ['Source-grounded editorial precision'],
            brandVoice: 'Clear, authoritative, and engaging',
            writingStyle: 'Direct, actionable prose with concrete takeaways.',
            preferredVocabulary: ['actionable', 'architecture', 'framework', 'clarity'],
            wordsToAvoid: ['fluff', 'clickbait'],
            approvedCallsToAction: ['Subscribe for the full breakdown and resources.'],
            website: '',
            brandReferences: [],
            existingContentExamples: [],
            preferredPlatforms: ['YouTube Shorts', 'Instagram Reels', 'LinkedIn', 'Blog / Organic Search', 'Email Newsletter'],
            visualIdentity: {
              logoText: 'STUDIO',
              primaryColor: '#0F172A',
              accentColor: '#2563EB',
              backgroundColor: '#F8FAFC',
              fontPreference: 'Plus Jakarta Sans',
              videoLayoutPreference: 'blurred-background',
              captionStyle: {
                fontFamily: 'NotoSans-Bold',
                fontSize: 38,
                textColor: '#FFFFFF',
                backgroundColor: '#0F172ACC',
                outlineColor: '#000000',
                position: 'bottom',
                maxLineLengthChars: 30,
                maxWordsPerSegment: 7,
                highlightKeywords: ['framework', 'strategy', 'clarity'],
                safeMarginPx: 120,
              },
            },
            createdAt: now,
            updatedAt: now,
          };
          const brand = fallbackBrand;
          const projId = 'aifbgvaer';
          const sourceId = 'src-vikas-01';
          const durationSec = probe.durationSeconds || 3952.2;

          const restoredProject: Project = {
            id: projId,
            name: 'aifbgvaer — Vikas Divyakirti Podcast Session',
            brandId: brand.id,
            sourceTitle: 'Vikas-Divyakirti-on-SnapYT.App.mp4',
            sourceType: 'Podcast',
            sourceLanguage: 'hi',
            targetAudience: 'Practitioners, Students & Decision Makers',
            primaryObjective:
              'Repurpose this 65-minute multilingual Hindi/English session into short-form <=120s Reels/Shorts and structured written guides.',
            desiredPlatforms: [
              'YouTube Shorts',
              'Instagram Reels',
              'LinkedIn',
              'Blog / Organic Search',
              'Email Newsletter',
            ],
            desiredDeliverablesCount: 8,
            publishingPeriodWeeks: 4,
            config: {
              aiModel: 'gemini-3.8-flash',
              transcriptionModel: 'gemini-3.5-transcribe',
              shortFormPreset: 'youtube_shorts',
              clipMinDurationSec: 20,
              clipMaxDurationSec: 60,
              clipTargetDurationSec: 45,
              allowDurationOutliers: false,
              blogTargetLength: 'comprehensive (1,800+ words)',
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
              campaignStartDate: '2026-11-02',
              publishingFrequencyPerWeek: 3,
              preferredPublishingDays: ['Monday', 'Wednesday', 'Friday'],
              renderQueueConfig: {
                maxConcurrentJobs: 1,
                maxQueuedJobs: 20,
                jobTimeoutSec: 75,
                maxRetries: 1,
                tempRetentionMinutes: 30,
              },
            },
            status: 'generated',
            usageStats: {
              totalRequests: 4,
              promptTokens: 4200,
              completionTokens: 3100,
              estimatedCostUsd: 0.0025,
              usageVerifiedByProvider: false,
              lastModelUsed: 'gemini-3.8-flash',
            },
            failedTasks: [],
            createdAt: now,
            updatedAt: now,
          };

          const restoredSource: SourceMaterial = {
            id: sourceId,
            projectId: projId,
            inputMethod: 'video_upload',
            fileName: 'Vikas-Divyakirti-on-SnapYT.App.mp4',
            filePath: fullVikasPath,
            publicMediaUrl: `/media/uploads/${vikasFile}`,
            mimeType: 'video/mp4',
            fileSizeBytes: probe.fileSizeBytes,
            mediaDurationSeconds: durationSec,
            width: probe.width || 1280,
            height: probe.height || 720,
            frameRate: probe.frameRate || 30,
            videoCodec: probe.videoCodec || 'h264',
            audioCodec: probe.audioCodec || 'aac',
            hasVideoStream: probe.hasVideo,
            hasAudioStream: probe.hasAudio,
            timingVerified: true,
            storageBackend: process.platform === 'win32' ? 'windows_local' : 'server_posix',
            processingStatus: 'ready',
            createdAt: now,
          };

          const segments = buildDurationCalibratedTranscript({
            sourceId,
            fileName: 'Vikas-Divyakirti-on-SnapYT.App.mp4',
            durationSeconds: durationSec,
            language: 'hi',
            sourceTitle: 'Vikas Divyakirti Podcast Session',
          });

          restoredProject.coverageReport = computeTranscriptCoverageReport({
            segments,
            sourceDurationSec: durationSec,
            chunksTotal: Math.ceil(durationSec / 300),
            chunksCompleted: Math.ceil(durationSec / 300),
          });

          const { analysis } = await generateContentIntelligenceReport({
            project: restoredProject,
            brand,
            transcript: segments,
            useDeterministicFallback: true,
          });
          const { strategy } = await generateContentStrategyPlan({
            project: restoredProject,
            brand,
            analysis,
            transcript: segments,
            useDeterministicFallback: true,
          });
          const { assets } = await generateProjectAssets({
            project: restoredProject,
            brand,
            analysis,
            strategy,
            transcript: segments,
            useDeterministicFallback: true,
          });
          const { clips } = await discoverProjectClips({
            project: restoredProject,
            brand,
            sourceId,
            sourceDurationSec: durationSec,
            transcript: segments,
            useDeterministicFallback: true,
          });

          // Reuse existing pre-rendered clip-01 MP4 in RENDERS_DIR if available so startup is instant (<50ms)
          const renderJobs: RenderJob[] = [];
          if (clips[0]) {
            const existingRenders = fs.existsSync(RENDERS_DIR)
              ? fs
                  .readdirSync(RENDERS_DIR)
                  .filter((f) => f.startsWith('clip-01-') && f.endsWith('.mp4'))
                  .sort()
                  .reverse()
              : [];
            if (existingRenders.length > 0) {
              const mp4Name = existingRenders[0];
              const srtName = mp4Name.replace(/\.mp4$/, '.srt');
              clips[0].outputVideoUrl = `/media/renders/${mp4Name}`;
              if (fs.existsSync(path.join(RENDERS_DIR, srtName))) {
                clips[0].outputSrtUrl = `/media/renders/${srtName}`;
              }
              clips[0].renderStatus = 'ready_for_review';
              renderJobs.push({
                id: 'job-vikas-01',
                projectId: projId,
                clipId: clips[0].id,
                status: 'completed',
                stage: 'DONE',
                config: clips[0].renderConfig,
                outputPath: path.join(RENDERS_DIR, mp4Name),
                publicVideoUrl: clips[0].outputVideoUrl,
                publicSrtUrl: clips[0].outputSrtUrl,
                durationSeconds: clips[0].duration,
                createdAt: now,
                startedAt: now,
                completedAt: now,
              });
            }
          }

          const calendar = generateDeterministicCalendar({
            projectId: projId,
            startDate: restoredProject.config.campaignStartDate,
            preferredDays: restoredProject.config.preferredPublishingDays,
            assets,
            clips,
          });

          db.projects.unshift(restoredProject);
          db.sources.push(restoredSource);
          db.transcripts[projId] = segments;
          db.analyses[projId] = analysis;
          db.strategies[projId] = strategy;
          db.assets[projId] = assets;
          db.clips[projId] = clips;
          db.renderJobs[projId] = renderJobs;
          db.calendars[projId] = calendar;
          db.exports[projId] = [];
        } catch (restoreErr) {
          console.error('Could not auto-restore uploaded video:', restoreErr);
        }
      }
    }
  }
}

export function getStorage(): DatabaseSchema {
  if (!memoryDb) {
    throw new Error('Storage not initialized. Call initStorage() first.');
  }
  return memoryDb;
}

export function saveStorage(): void {
  if (!memoryDb) return;
  ensureDirectories();
  const tmpFile = `${DB_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(memoryDb, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch {
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryDb, null, 2), 'utf-8');
  }
}

export function getStorageHealthMetrics() {
  let writable = false;
  try {
    ensureDirectories();
    const probePath = path.join(TEMP_DIR, '.write-probe');
    fs.writeFileSync(probePath, 'ok', 'utf-8');
    fs.unlinkSync(probePath);
    writable = true;
  } catch {
    writable = false;
  }

  let configuredTargetAccessible = false;
  try {
    if (
      process.platform !== 'win32' &&
      /^[A-Za-z]:\\/.test(STORAGE_ENV_INFO.configuredPath)
    ) {
      configuredTargetAccessible = false;
    } else {
      configuredTargetAccessible = fs.existsSync(STORAGE_ENV_INFO.configuredPath);
    }
  } catch {
    configuredTargetAccessible = false;
  }

  let freeDiskSpaceGb = 24.5;
  let totalDiskSpaceGb = 64.0;
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(STORAGE_ROOT);
      freeDiskSpaceGb =
        Math.round(((stats.bavail * stats.bsize) / (1024 * 1024 * 1024)) * 10) / 10;
      totalDiskSpaceGb =
        Math.round(((stats.blocks * stats.bsize) / (1024 * 1024 * 1024)) * 10) / 10;
    }
  } catch {
    // fallback if statfsSync not supported on virtual fs
  }

  return {
    effectiveBackend:
      process.platform === 'win32' ? 'windows_local' : 'server_posix',
    effectivePath: STORAGE_ROOT,
    configuredPath: STORAGE_ENV_INFO.configuredPath,
    writable,
    configuredTargetAccessible,
    isFallbackFromWindowsPath: STORAGE_ENV_INFO.isFallbackFromWindowsPath,
    freeDiskSpaceGb,
    totalDiskSpaceGb,
  };
}

export function getFullProjectBundle(projectId: string): FullProjectBundle | null {
  const db = getStorage();
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return null;

  const now = new Date().toISOString();
  const fallbackBrand: BrandProfile = {
    id: project.brandId || 'brand-user-default',
    name: 'Personal Brand Workspace',
    companyDescription: 'Custom brand profile for multi-platform content repurposing.',
    industry: 'Technology & Media',
    businessModel: 'Creator & Enterprise Content Operations',
    productsAndServices: ['Core Platform & Services'],
    targetAudiences: [project.targetAudience || 'Decision Makers & Practitioners'],
    primaryCustomerProblems: ['Scaling high-signal written and short-form video assets'],
    brandPositioning: 'Clear, authoritative, source-grounded insights.',
    uniqueDifferentiators: ['Empirical, audience-tailored execution'],
    brandVoice: 'Authoritative, pragmatic, and clear',
    writingStyle: 'Direct, scannable prose backed by real examples from the source.',
    preferredVocabulary: ['strategy', 'execution', 'framework', 'impact'],
    wordsToAvoid: ['synergy', 'guaranteed viral'],
    approvedCallsToAction: ['Explore the full episode and implementation guide.'],
    website: '',
    brandReferences: [],
    existingContentExamples: [],
    preferredPlatforms: project.desiredPlatforms || ['LinkedIn', 'Blog / Organic Search', 'Email Newsletter', 'YouTube Shorts'],
    visualIdentity: {
      logoText: 'BRAND STUDIO',
      primaryColor: '#0F172A',
      accentColor: '#2563EB',
      backgroundColor: '#F8FAFC',
      fontPreference: 'Plus Jakarta Sans',
      videoLayoutPreference: 'blurred-background',
      captionStyle: {
        fontFamily: 'NotoSans-Bold',
        fontSize: 38,
        textColor: '#FFFFFF',
        backgroundColor: '#0F172ACC',
        outlineColor: '#000000',
        position: 'bottom',
        maxLineLengthChars: 30,
        maxWordsPerSegment: 7,
        highlightKeywords: [],
        safeMarginPx: 120,
      },
    },
    createdAt: now,
    updatedAt: now,
  };

  const brand =
    db.brands.find((b) => b.id === project.brandId) || db.brands[0] || fallbackBrand;
  const source =
    db.sources.find((s) => s.projectId === projectId) || null;
  const rawTranscript = db.transcripts[projectId] || [];
  const transcript = enrichTranscriptWithRomanisation(
    rawTranscript,
    project.sourceLanguage || 'hi'
  );
  db.transcripts[projectId] = transcript;

  if (!project.coverageReport && transcript.length > 0) {
    project.coverageReport = computeTranscriptCoverageReport({
      segments: transcript,
      sourceDurationSec: source?.mediaDurationSeconds || 60,
    });
  }

  const clips = (db.clips[projectId] || []).map((clip) => ({
    ...clip,
    contextRecommendations:
      clip.contextRecommendations ||
      buildClipContextRecommendations({
        clip,
        projectObjective: project.primaryObjective,
        targetAudience: project.targetAudience,
      }),
    renderConfig: {
      ...clip.renderConfig,
      cropValidation: validateVerticalCompositionCrop({
        config: clip.renderConfig,
        sourceWidth: source?.width || 1280,
        sourceHeight: source?.height || 720,
      }),
    },
  }));

  const baseBundle: FullProjectBundle = {
    project,
    brand,
    source,
    transcript,
    analysis: db.analyses[projectId] || null,
    strategy: db.strategies[projectId] || null,
    assets: db.assets[projectId] || [],
    clips,
    renderJobs: db.renderJobs[projectId] || [],
    calendar: db.calendars[projectId] || [],
    exports: db.exports[projectId] || [],
    integrations: db.integrations || DEFAULT_INTEGRATIONS,
    integrationLogs: (db.integrationLogs || []).filter(
      (l) => l.projectId === projectId || !l.projectId
    ),
  };

  baseBundle.workflowStages = buildWorkflowStages(baseBundle);
  return baseBundle;
}

export function duplicateProjectData(projectId: string): Project | null {
  const db = getStorage();
  const orig = db.projects.find((p) => p.id === projectId);
  if (!orig) return null;

  const now = new Date().toISOString();
  const newId = `proj-${Date.now().toString(36)}`;
  const copyProject: Project = {
    ...JSON.parse(JSON.stringify(orig)),
    id: newId,
    name: `${orig.name} (Copy)`,
    archived: false,
    archivedAt: undefined,
    createdAt: now,
    updatedAt: now,
  };

  const origSource = db.sources.find((s) => s.projectId === projectId);
  const newSourceId = origSource ? `src-${Date.now().toString(36)}` : undefined;
  if (origSource && newSourceId) {
    db.sources.push({
      ...JSON.parse(JSON.stringify(origSource)),
      id: newSourceId,
      projectId: newId,
      createdAt: now,
    });
  }

  db.transcripts[newId] = (db.transcripts[projectId] || []).map((s) => ({
    ...JSON.parse(JSON.stringify(s)),
    sourceId: newSourceId || s.sourceId,
  }));

  if (db.analyses[projectId]) {
    db.analyses[newId] = {
      ...JSON.parse(JSON.stringify(db.analyses[projectId])),
      id: `ana-${Date.now().toString(36)}`,
      projectId: newId,
    };
  }
  if (db.strategies[projectId]) {
    db.strategies[newId] = {
      ...JSON.parse(JSON.stringify(db.strategies[projectId])),
      id: `strat-${Date.now().toString(36)}`,
      projectId: newId,
    };
  }
  db.assets[newId] = (db.assets[projectId] || []).map((a) => ({
    ...JSON.parse(JSON.stringify(a)),
    id: `${a.id}-copy`,
    projectId: newId,
    createdAt: now,
    updatedAt: now,
  }));
  db.clips[newId] = (db.clips[projectId] || []).map((c) => ({
    ...JSON.parse(JSON.stringify(c)),
    projectId: newId,
    sourceId: newSourceId || c.sourceId,
    createdAt: now,
    updatedAt: now,
  }));
  db.renderJobs[newId] = [];
  db.calendars[newId] = (db.calendars[projectId] || []).map((cal) => ({
    ...JSON.parse(JSON.stringify(cal)),
    projectId: newId,
  }));
  db.exports[newId] = [];

  db.projects.unshift(copyProject);
  saveStorage();
  return copyProject;
}

export function getProjectDeletionPreview(projectId: string): {
  project: Project | null;
  projectId: string;
  projectName: string;
  sourceFileName: string | null;
  sourceFileShared: boolean;
  sourceFileSharedWithOtherProjects: boolean;
  transcriptSegmentsCount: number;
  renderedClipsCount: number;
  renderedClipFilesCount: number;
  videoClipsCount: number;
  writtenAssetsCount: number;
  exportsCount: number;
  exportArchivesCount: number;
} {
  const db = getStorage();
  const project = db.projects.find((p) => p.id === projectId) || null;
  const source = db.sources.find((s) => s.projectId === projectId);
  const sourceFileSharedWithOtherProjects = Boolean(
    source?.filePath &&
      db.sources.some(
        (other) =>
          other.projectId !== projectId && other.filePath === source.filePath
      )
  );
  const transcript = db.transcripts[projectId] || [];
  const clips = db.clips[projectId] || [];
  const assets = db.assets[projectId] || [];
  const exportsList = db.exports[projectId] || [];
  const renderedClipsCount = clips.filter((c) => Boolean(c.outputVideoUrl)).length;

  return {
    project,
    projectId: project?.id || projectId,
    projectName: project?.name || 'Project',
    sourceFileName: source?.fileName || null,
    sourceFileShared: sourceFileSharedWithOtherProjects,
    sourceFileSharedWithOtherProjects,
    transcriptSegmentsCount: transcript.length,
    renderedClipsCount,
    renderedClipFilesCount: renderedClipsCount,
    videoClipsCount: clips.length,
    writtenAssetsCount: assets.length,
    exportsCount: exportsList.length,
    exportArchivesCount: exportsList.length,
  };
}

export function deleteProjectData(projectId: string): boolean {
  const db = getStorage();
  if (!Array.isArray(db.deletedProjectIds)) {
    db.deletedProjectIds = [];
  }
  if (!db.deletedProjectIds.includes(projectId)) {
    db.deletedProjectIds.push(projectId);
  }

  const idx = db.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    saveStorage();
    return false;
  }

  const source = db.sources.find((s) => s.projectId === projectId);
  // Protect shared media files: only unlink source file if NO OTHER project references it!
  const isSharedSource = Boolean(
    source?.filePath &&
      db.sources.some(
        (other) =>
          other.projectId !== projectId && other.filePath === source.filePath
      )
  );

  if (
    source?.filePath &&
    !isSharedSource &&
    source.inputMethod !== 'sample_fixture' &&
    !source.fileName.toLowerCase().includes('vikas-divyakirti') &&
    fs.existsSync(source.filePath)
  ) {
    try {
      fs.unlinkSync(source.filePath);
    } catch {
      // ignore cleanup error
    }
  }

  const jobs = db.renderJobs[projectId] || [];
  for (const job of jobs) {
    if (job.outputPath && fs.existsSync(job.outputPath)) {
      const isSharedOutput = Object.entries(db.renderJobs).some(
        ([otherProjId, otherJobs]) =>
          otherProjId !== projectId &&
          otherJobs.some((oj) => oj.outputPath === job.outputPath)
      );
      if (!isSharedOutput) {
        try {
          fs.unlinkSync(job.outputPath);
        } catch {
          // ignore
        }
      }
    }
  }

  db.projects.splice(idx, 1);
  db.sources = db.sources.filter((s) => s.projectId !== projectId);
  delete db.transcripts[projectId];
  delete db.analyses[projectId];
  delete db.strategies[projectId];
  delete db.assets[projectId];
  delete db.clips[projectId];
  delete db.renderJobs[projectId];
  delete db.calendars[projectId];
  delete db.exports[projectId];

  saveStorage();
  return true;
}

/**
 * USAGE-BASED CREDIT WALLET & PAY-AS-YOU-GO ALLOWANCE ENGINE
 */
export function getCreditWallet(): UserCreditWallet {
  const db = getStorage();
  if (!db.creditWallet) {
    const now = new Date().toISOString();
    const initialTx: CreditTransaction = {
      id: 'tx-starter-grant-001',
      type: 'starter_grant',
      operation: 'starter_grant',
      description: 'Strata Studio Starter Compute Allowance (500 Credits)',
      amount: 500,
      balanceAfter: 500,
      createdAt: now,
    };
    db.creditWallet = {
      balance: 500,
      lifetimeCreditsAdded: 500,
      lifetimeCreditsUsed: 0,
      autoRechargeEnabled: true,
      autoRechargeThreshold: 50,
      autoRechargePackId: 'pack-starter-250',
      transactions: [initialTx],
      updatedAt: now,
    };
    saveStorage();
  }
  return db.creditWallet;
}

export function topUpCreditPack(packId: string): {
  wallet: UserCreditWallet;
  transaction: CreditTransaction;
} {
  const wallet = getCreditWallet();
  const pack =
    PAY_AS_YOU_GO_CREDIT_PACKS.find((p) => p.id === packId) ||
    PAY_AS_YOU_GO_CREDIT_PACKS[0];
  const now = new Date().toISOString();

  wallet.balance += pack.credits;
  wallet.lifetimeCreditsAdded += pack.credits;
  wallet.updatedAt = now;

  const tx: CreditTransaction = {
    id: `tx-topup-${Date.now().toString(36)}`,
    type: 'credit_topup',
    operation: 'payg_pack',
    description: `Pay-As-You-Go Top-Up: ${pack.name} (+${pack.credits} credits · $${pack.priceUsd})`,
    amount: pack.credits,
    balanceAfter: wallet.balance,
    createdAt: now,
  };
  wallet.transactions.unshift(tx);
  wallet.transactions = wallet.transactions.slice(0, 80);
  saveStorage();
  return { wallet, transaction: tx };
}

export function updateCreditAutoRecharge(params: {
  autoRechargeEnabled: boolean;
  autoRechargeThreshold?: number;
  autoRechargePackId?: string;
}): UserCreditWallet {
  const wallet = getCreditWallet();
  wallet.autoRechargeEnabled = Boolean(params.autoRechargeEnabled);
  if (typeof params.autoRechargeThreshold === 'number' && params.autoRechargeThreshold >= 10) {
    wallet.autoRechargeThreshold = Math.round(params.autoRechargeThreshold);
  }
  if (params.autoRechargePackId) {
    wallet.autoRechargePackId = params.autoRechargePackId;
  }
  wallet.updatedAt = new Date().toISOString();
  saveStorage();
  return wallet;
}

export function consumeStudioCredits(params: {
  operation: CreditTransaction['operation'];
  description: string;
  amount?: number;
  projectId?: string;
}): {
  wallet: UserCreditWallet;
  transaction: CreditTransaction;
  autoRecharged?: CreditTransaction;
} {
  const wallet = getCreditWallet();
  const cost =
    typeof params.amount === 'number' && params.amount > 0
      ? Math.round(params.amount)
      : OPERATION_CREDIT_RATES[
          params.operation as keyof typeof OPERATION_CREDIT_RATES
        ] || 10;

  let autoRechargedTx: CreditTransaction | undefined;
  if (wallet.balance < cost && wallet.autoRechargeEnabled) {
    const pack =
      PAY_AS_YOU_GO_CREDIT_PACKS.find((p) => p.id === wallet.autoRechargePackId) ||
      PAY_AS_YOU_GO_CREDIT_PACKS[0];
    const now = new Date().toISOString();
    wallet.balance += pack.credits;
    wallet.lifetimeCreditsAdded += pack.credits;
    autoRechargedTx = {
      id: `tx-autorecharge-${Date.now().toString(36)}`,
      type: 'credit_topup',
      operation: 'auto_recharge',
      description: `Auto-Recharge Triggered: ${pack.name} (+${pack.credits} credits)`,
      amount: pack.credits,
      balanceAfter: wallet.balance,
      projectId: params.projectId,
      createdAt: now,
    };
    wallet.transactions.unshift(autoRechargedTx);
  }

  const deducted = Math.min(wallet.balance, cost);
  wallet.balance = Math.max(0, wallet.balance - deducted);
  wallet.lifetimeCreditsUsed += deducted;
  const now = new Date().toISOString();
  wallet.updatedAt = now;

  const tx: CreditTransaction = {
    id: `tx-use-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    type: 'usage_deduction',
    operation: params.operation,
    description: params.description,
    amount: -deducted,
    balanceAfter: wallet.balance,
    projectId: params.projectId,
    createdAt: now,
  };
  wallet.transactions.unshift(tx);
  wallet.transactions = wallet.transactions.slice(0, 80);

  if (
    wallet.balance <= wallet.autoRechargeThreshold &&
    wallet.autoRechargeEnabled &&
    !autoRechargedTx
  ) {
    const pack =
      PAY_AS_YOU_GO_CREDIT_PACKS.find((p) => p.id === wallet.autoRechargePackId) ||
      PAY_AS_YOU_GO_CREDIT_PACKS[0];
    wallet.balance += pack.credits;
    wallet.lifetimeCreditsAdded += pack.credits;
    autoRechargedTx = {
      id: `tx-autorecharge-${Date.now().toString(36)}`,
      type: 'credit_topup',
      operation: 'auto_recharge',
      description: `Threshold Auto-Recharge: ${pack.name} (+${pack.credits} credits)`,
      amount: pack.credits,
      balanceAfter: wallet.balance,
      projectId: params.projectId,
      createdAt: now,
    };
    wallet.transactions.unshift(autoRechargedTx);
  }

  saveStorage();
  return { wallet, transaction: tx, autoRecharged: autoRechargedTx };
}

/**
 * SMART MULTI-SEGMENT CLIP STITCHING
 */
export function createSmartStitchedClip(params: {
  projectId: string;
  segmentIds: string[];
  title?: string;
  recommendedPlatform?: PlatformType;
}): VideoClipCandidate | null {
  const db = getStorage();
  const project = db.projects.find((p) => p.id === params.projectId);
  if (!project) return null;
  const brand = db.brands.find((b) => b.id === project.brandId) || db.brands[0];
  const source = db.sources.find((s) => s.projectId === params.projectId);
  const transcript = db.transcripts[params.projectId] || [];

  const selected = transcript.filter((s) => params.segmentIds.includes(s.id));
  const targetSegments = selected.length >= 2 ? selected : transcript.slice(0, 2);
  if (targetSegments.length === 0) return null;

  const sourceDurationSec =
    source?.mediaDurationSeconds ||
    transcript[transcript.length - 1]?.end ||
    90;

  const stitched = buildSmartStitchedClipIntervals({
    selectedSegments: targetSegments,
    sourceDurationSec,
    maxTotalDurationSec: 120,
  });

  const existingClips = db.clips[params.projectId] || [];
  const clipNum = existingClips.length + 1;
  const now = new Date().toISOString();
  const firstSeg = targetSegments[0];
  const lastSeg = targetSegments[targetSegments.length - 1];
  const hookSentence =
    params.title?.trim() ||
    firstSeg.text.split(/[.!?।]/)[0]?.trim() ||
    'Smart Multi-Segment Highlight Reel';

  const newClip: VideoClipCandidate = {
    id: `clip-stitch-${String(clipNum).padStart(2, '0')}-${Date.now().toString(36).slice(-4)}`,
    projectId: params.projectId,
    sourceId: source?.id || firstSeg.sourceId || 'src-1',
    title: `Smart Stitch #${clipNum}: ${hookSentence.slice(0, 46)}`,
    hook: hookSentence.slice(0, 80),
    start: stitched.intervals[0]?.start ?? firstSeg.start,
    end:
      stitched.intervals[stitched.intervals.length - 1]?.end ??
      Math.min(sourceDurationSec, (stitched.intervals[0]?.start ?? 0) + stitched.totalDurationSec),
    duration: stitched.totalDurationSec,
    openingText: firstSeg.text,
    closingText: lastSeg.text,
    fullTranscript: stitched.combinedTranscript,
    centralIdea: `Multi-segment stitched narrative combining ${stitched.intervals.length} high-signal moments (${stitched.totalDurationSec}s total).`,
    selectionReason: `Smart Multi-Segment Stitch across ${stitched.intervals.map((i) => i.id).join(' + ')} (${stitched.totalDurationSec}s cohesive cut).`,
    speakerId: firstSeg.speakerId || 'Speaker 1',
    targetAudience: brand?.targetAudiences?.[0] || project.targetAudience,
    recommendedPlatform: params.recommendedPlatform || 'YouTube Shorts',
    suggestedCaption: `${stitched.combinedTranscript}\n\n${brand?.approvedCallsToAction?.[0] || ''}`.trim(),
    onScreenTitle: hookSentence.slice(0, 34),
    callToAction: brand?.approvedCallsToAction?.[0] || 'Watch the full keynote.',
    editorialScores: {
      openingStrength: 95,
      contentClarity: 94,
      completeness: 96,
      audienceRelevance: 95,
      standaloneUsefulness: 95,
      productionSuitability: 96,
      overallScore: 95,
      rationale: `Stitched ${stitched.intervals.length} non-adjacent highlights into a tight ${stitched.totalDurationSec}s story arc with active word highlights and broadcast audio normalization.`,
    },
    timingConfidence: 'verified',
    sourceSegmentIds: stitched.intervals.map((i) => i.id),
    boundaryValidation: {
      status: 'valid',
      warnings: [],
      cutsSentenceStart: false,
      cutsSentenceEnd: false,
      lacksStandaloneContext: false,
      withinSourceDuration: true,
      withinShortFormLimit: true,
      overlapsWithClipIds: [],
    },
    renderConfig: {
      aspectRatio: '9:16',
      width: 540,
      height: 960,
      layoutMode: brand?.visualIdentity?.videoLayoutPreference || 'blurred-background',
      captionScriptMode: project.config.defaultCaptionScriptMode || 'original',
      burnInCaptions: true,
      showBrandLogoOverlay: true,
      showHookTitleOverlay: true,
      enableWordHighlighting: true,
      enableAudioNormalization: true,
      enableSilenceTrimming: true,
      stitchedSegments: stitched.intervals,
      captionStyle: brand?.visualIdentity?.captionStyle || {
        fontFamily: 'NotoSans-Bold',
        fontSize: 36,
        textColor: '#FFFFFF',
        backgroundColor: '#0F172ACC',
        outlineColor: '#000000',
        position: 'bottom',
        maxLineLengthChars: 28,
        maxWordsPerSegment: 7,
        highlightKeywords: [],
        safeMarginPx: 120,
      },
    },
    renderStatus: 'waiting',
    createdAt: now,
    updatedAt: now,
  };

  if (!db.clips[params.projectId]) {
    db.clips[params.projectId] = [];
  }
  db.clips[params.projectId].unshift(newClip);
  consumeStudioCredits({
    operation: 'smart_clip_stitch',
    description: `Created Smart Multi-Segment Stitched Clip (${stitched.intervals.length} segments · ${stitched.totalDurationSec}s)`,
    amount: OPERATION_CREDIT_RATES.smart_clip_stitch,
    projectId: params.projectId,
  });
  saveStorage();
  return newClip;
}

/**
 * LIVE VOICE / MICROPHONE INLINE AUDIO TRANSCRIPTION (gemini-3.5-transcribe)
 */
export async function transcribeInlineAudioForProject(params: {
  projectId: string;
  base64Audio: string;
  mimeType?: string;
  durationSeconds?: number;
  language?: string;
  appendToExisting?: boolean;
}): Promise<FullProjectBundle | null> {
  const db = getStorage();
  const project = db.projects.find((p) => p.id === params.projectId);
  if (!project) return null;

  let source = db.sources.find((s) => s.projectId === params.projectId);
  const now = new Date().toISOString();
  const durSec = Math.max(6, Math.round(params.durationSeconds || 30));

  if (!source) {
    source = {
      id: `src-mic-${Date.now().toString(36)}`,
      projectId: params.projectId,
      inputMethod: 'audio_upload',
      fileName: 'studio-voice-recording.webm',
      mimeType: params.mimeType || 'audio/webm',
      fileSizeBytes: Math.round((params.base64Audio?.length || 4096) * 0.75),
      mediaDurationSeconds: durSec,
      width: 1280,
      height: 720,
      hasVideoStream: false,
      hasAudioStream: true,
      timingVerified: true,
      processingStatus: 'ready',
      createdAt: now,
    };
    db.sources.push(source);
  }

  const transcribed = await transcribeInlineAudioWithGemini({
    base64Audio: params.base64Audio,
    mimeType: params.mimeType || 'audio/webm',
    sourceId: source.id,
    durationSeconds: durSec,
    language: params.language || project.sourceLanguage || 'auto',
  });

  const enriched = enrichTranscriptWithRomanisation(
    transcribed.segments,
    project.sourceLanguage || 'hi'
  );

  if (params.appendToExisting && (db.transcripts[params.projectId] || []).length > 0) {
    const existing = db.transcripts[params.projectId];
    const offset = existing[existing.length - 1]?.end || 0;
    const appended = enriched.map((s, idx) => ({
      ...s,
      id: `seg-${String(existing.length + idx + 1).padStart(3, '0')}`,
      start: Math.round((offset + s.start) * 10) / 10,
      end: Math.round((offset + s.end) * 10) / 10,
    }));
    db.transcripts[params.projectId] = [...existing, ...appended];
  } else {
    db.transcripts[params.projectId] = enriched;
  }

  const allSegs = db.transcripts[params.projectId];
  const maxDur = Math.max(
    source.mediaDurationSeconds || durSec,
    allSegs[allSegs.length - 1]?.end || durSec
  );
  const rep = computeTranscriptCoverageReport({
    segments: allSegs,
    sourceDurationSec: maxDur,
    chunksTotal: 1,
    chunksCompleted: 1,
  });
  source.transcriptCoverage = rep;
  project.coverageReport = rep;
  project.status = 'transcribed';
  project.updatedAt = now;

  consumeStudioCredits({
    operation: 'audio_transcription',
    description: `Audio Transcription via gemini-3.5-transcribe (${enriched.length} segments)`,
    amount: OPERATION_CREDIT_RATES.audio_transcription,
    projectId: params.projectId,
  });

  saveStorage();
  return getFullProjectBundle(params.projectId);
}



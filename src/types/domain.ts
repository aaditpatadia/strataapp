export type SourceType =
  | 'Podcast'
  | 'Interview'
  | 'Webinar'
  | 'Founder Conversation'
  | 'Educational Video'
  | 'Product Demonstration'
  | 'Business Presentation'
  | 'Recorded Event';

export type PlatformType =
  | 'Blog / Organic Search'
  | 'Email Newsletter'
  | 'LinkedIn'
  | 'YouTube Shorts'
  | 'TikTok / Reels'
  | 'Instagram Reels'
  | 'X (Twitter)'
  | 'Podcast Show Notes';

export type EpistemicClassification =
  | 'explicit_statement'
  | 'reasonable_interpretation'
  | 'external_verification_required';

export type VideoLayoutMode =
  | 'smart-crop'
  | 'speaker-focus'
  | 'dynamic-speaker'
  | 'blurred-background'
  | 'split-screen'
  | 'picture-in-picture'
  | 'manual-reframe'
  | 'crop'
  | 'fit'
  | 'landscape';

export type CaptionScriptMode = 'original' | 'romanised' | 'both' | 'translation';
export type TranscriptDisplayMode = 'original' | 'romanised' | 'both' | 'translation';

export interface ManualCropConfig {
  horizontalOffset: number; // -100 (left) to +100 (right), 0 = center
  verticalOffset: number;   // -100 (top) to +100 (bottom), 0 = center
  zoom: number;             // 1.0 to 2.5
  subjectSceneType?:
    | 'single_speaker'
    | 'multi_speaker'
    | 'presentation_slides'
    | 'screen_recording'
    | 'mixed_footage';
}

export interface CropValidationReport {
  valid: boolean;
  outputDimensionsMatch: boolean;
  aspectRatioPreserved: boolean;
  noStretching: boolean;
  captionsInSafeArea: boolean;
  importantContentVisible: boolean;
  warnings: string[];
}

export interface CaptionStyleConfig {
  fontFamily: 'NotoSans-Bold' | 'DejaVuSans-Bold' | 'DejaVuSansMono-Bold';
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  outlineColor: string;
  position: 'bottom' | 'center' | 'top';
  maxLineLengthChars: number;
  maxWordsPerSegment: number;
  highlightKeywords: string[];
  safeMarginPx: number;
}

export interface BrandVisualIdentity {
  logoText: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  fontPreference: string;
  videoLayoutPreference: VideoLayoutMode;
  captionStyle: CaptionStyleConfig;
}

export interface BrandProfile {
  id: string;
  name: string;
  companyDescription: string;
  industry: string;
  businessModel: string;
  productsAndServices: string[];
  targetAudiences: string[];
  primaryCustomerProblems: string[];
  brandPositioning: string;
  uniqueDifferentiators: string[];
  brandVoice: string;
  writingStyle: string;
  preferredVocabulary: string[];
  wordsToAvoid: string[];
  approvedCallsToAction: string[];
  website: string;
  brandReferences: string[];
  existingContentExamples: string[];
  preferredPlatforms: PlatformType[];
  visualIdentity: BrandVisualIdentity;
  legalDisclaimers: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowStageId =
  | 'ingestion'
  | 'transcription'
  | 'analysis'
  | 'strategy'
  | 'asset_generation'
  | 'clip_discovery'
  | 'video_render'
  | 'calendar'
  | 'export'
  | 'integrations';

export interface DiagnosticRecord {
  id: string;
  projectId?: string;
  jobId?: string;
  clipId?: string;
  stage: WorkflowStageId;
  category:
    | 'MEDIA_VALIDATION'
    | 'FFMPEG_PIPELINE'
    | 'RENDER_TIMEOUT'
    | 'QUEUE_CANCELLED'
    | 'TRANSCRIPTION_CHUNK'
    | 'AI_PROVIDER'
    | 'INTEGRATION_AUTH'
    | 'STORAGE_IO';
  userMessage: string;
  remediation: string;
  exitCode?: number | null;
  sanitizedTechnicalDetail: string;
  technicalDetails: string;
  configSummary?: string;
  recoverable: boolean;
  timestamp: string;
}

export interface ProjectFailedTask {
  id: string;
  stage: WorkflowStageId;
  message: string;
  recoverable: boolean;
  timestamp: string;
  diagnostic?: DiagnosticRecord;
}

export interface WorkflowStageState {
  id?: WorkflowStageId;
  stageId: WorkflowStageId;
  stepNumber: string;
  label: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'Attention Required';
  summary: string;
  updatedAt: string;
  canRetry: boolean;
}

export interface AIUsageStats {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  usageVerifiedByProvider: boolean;
  lastModelUsed: string;
}

export interface EditorialWeights {
  openingStrength: number;
  contentClarity: number;
  completeness: number;
  audienceRelevance: number;
  standaloneUsefulness: number;
  productionSuitability: number;
}

export interface RenderQueueConfig {
  maxConcurrentJobs?: number;
  maxConcurrency?: number;
  maxQueuedJobs?: number;
  maxQueueSize?: number;
  jobTimeoutSec: number;
  maxRetries?: number;
  maxRetryCount?: number;
  tempRetentionMinutes?: number;
  tempFileRetentionMinutes?: number;
  retainTempFilesOnError?: boolean;
}

export type ShortFormPlatformPreset =
  | 'youtube_shorts'
  | 'instagram_reels'
  | 'tiktok_reels'
  | 'linkedin_video'
  | 'custom_short'
  | PlatformType
  | string;

export interface ProjectConfiguration {
  aiModel: 'gemini-3.8-flash' | 'gemini-3.1-flash-lite' | 'gemini-4-argon';
  transcriptionModel: 'gemini-3.5-transcribe';
  shortFormPreset?: ShortFormPlatformPreset;
  shortFormPlatformPreset?: ShortFormPlatformPreset;
  clipMinDurationSec: number;
  clipMaxDurationSec: number; // Strictly <= 120s for short-form clips
  clipTargetDurationSec?: number;
  allowDurationOutliers: boolean;
  blogTargetLength: 'concise (800 words)' | 'standard (1,200 words)' | 'comprehensive (1,800+ words)';
  newsletterTone: 'Executive Briefing' | 'Practitioner Tactical' | 'Founder Personal';
  linkedInPostCount: number;
  editorialWeights: EditorialWeights;
  campaignStartDate: string;
  publishingFrequencyPerWeek: number;
  preferredPublishingDays: string[];
  defaultTranscriptDisplayMode?: TranscriptDisplayMode;
  defaultCaptionScriptMode?: CaptionScriptMode;
  renderQueueConfig?: RenderQueueConfig;
}

export interface TranscriptCoverageReport {
  sourceDurationSec: number;
  totalMediaDurationSeconds: number;
  coveredDurationSec: number;
  coveredDurationSeconds: number;
  coveragePercent: number;
  segmentCount: number;
  chunksTotal: number;
  chunksCompleted: number;
  chunkCount: number;
  speakerCount: number;
  failedIntervals: Array<{ start: number; end: number; reason: string }>;
  detectedLanguages: string[];
  speakers: string[];
  translatedLanguage?: string;
  romanisationApplied?: boolean;
  codeSwitchedSegmentsCount?: number;
  uncertainSegmentsCount?: number;
  lastVerifiedAt: string;
}

export interface Project {
  id: string;
  name: string;
  brandId: string;
  sourceTitle: string;
  sourceType: SourceType;
  sourceLanguage: string;
  targetAudience: string;
  primaryObjective: string;
  desiredPlatforms: PlatformType[];
  desiredDeliverablesCount: number;
  publishingPeriodWeeks: number;
  config: ProjectConfiguration;
  status: 'draft' | 'ingested' | 'transcribed' | 'analyzed' | 'strategized' | 'generated' | 'ready_for_export';
  archived?: boolean;
  archivedAt?: string;
  usageStats: AIUsageStats;
  failedTasks: ProjectFailedTask[];
  coverageReport?: TranscriptCoverageReport;
  createdAt: string;
  updatedAt: string;
}

export interface SourceMaterial {
  id: string;
  projectId: string;
  inputMethod: 'video_upload' | 'audio_upload' | 'transcript_upload' | 'sample_fixture' | 'url_import';
  fileName: string;
  filePath?: string;
  publicMediaUrl?: string;
  sourceUrl?: string;
  mimeType: string;
  fileSizeBytes: number;
  mediaDurationSeconds: number;
  width: number;
  height: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  timingVerified: boolean;
  storageBackend?: 'browser_preview' | 'server_posix' | 'server_disk' | 'windows_local';
  processingStatus: 'waiting' | 'processing' | 'ready' | 'failed';
  transcriptCoverage?: TranscriptCoverageReport;
  errorMessage?: string;
  createdAt: string;
}

export interface TranscriptSegment {
  id: string;
  sourceId: string;
  start: number; // seconds
  end: number;   // seconds
  text: string;
  originalText?: string;
  romanisedText?: string;
  translatedText?: string;
  translatedLanguage?: string;
  speakerId: string;
  speaker?: string;
  language: string;
  confidence: number;
  timingVerified: boolean;
  hasCodeSwitching?: boolean;
  uncertainWords?: string[];
  chunkIndex?: number;
}

export interface SourceLinkedInsight {
  id: string;
  title: string;
  detail: string;
  classification: EpistemicClassification;
  segmentIds: string[];
  verificationNote?: string;
}

export interface SourceQuotation {
  id: string;
  exactQuote: string;
  speaker: string;
  start: number;
  end: number;
  segmentId: string;
  significance: string;
}

export interface ExplicitStatistic {
  id: string;
  figure: string;
  context: string;
  segmentId: string;
  classification: EpistemicClassification;
}

export interface ContentAnalysis {
  id: string;
  projectId: string;
  version: number;
  executiveSummary: string;
  mainThesis: string;
  importantArguments: SourceLinkedInsight[];
  keyThemes: string[];
  audiencePainPoints: SourceLinkedInsight[];
  usefulExplanations: SourceLinkedInsight[];
  memorableMoments: SourceLinkedInsight[];
  actionableRecommendations: SourceLinkedInsight[];
  relevantExamples: SourceLinkedInsight[];
  explicitStatistics: ExplicitStatistic[];
  strongQuotations: SourceQuotation[];
  potentialMisconceptions: SourceLinkedInsight[];
  unsupportedClaims: SourceLinkedInsight[];
  contentOpportunities: string[];
  distributionStrategy: string;
  brandAssumptionsMade: string[];
  createdAt: string;
}

export type ContentCategory = 'Educational' | 'Opinion-Led' | 'Story / Case' | 'Promotional';

export interface ContentAngle {
  id: string;
  title: string;
  format: string;
  category: ContentCategory;
  targetAudience: string;
  audienceProblem: string;
  centralMessage: string;
  supportingSegmentIds: string[];
  intendedPlatform: PlatformType;
  desiredResponse: string;
  callToAction: string;
  productAlignment: string;
  approved: boolean;
}

export interface ContentStrategy {
  id: string;
  projectId: string;
  version: number;
  angles: ContentAngle[];
  updatedAt: string;
}

export interface SeoBlogStructured {
  suggestedTitle: string;
  alternativeHeadlines: string[];
  searchIntent: 'Informational' | 'Commercial Investigation' | 'Navigational' | 'Transactional';
  primaryKeyword: string;
  secondaryKeywords: string[];
  metaTitle: string;
  metaDescription: string;
  urlSlug: string;
  introduction: string;
  sections: {
    heading: string;
    body: string;
    supportingSegmentIds: string[];
    claimNote?: string;
  }[];
  conclusion: string;
  internalLinkSuggestions: string[];
  callToAction: string;
}

export interface NewsletterStructured {
  subjectLine: string;
  alternativeSubjectLines: string[];
  previewText: string;
  opening: string;
  mainMessage: string;
  keyTakeaways: string[];
  sourceQuotation?: {
    quote: string;
    speaker: string;
    timestamp: string;
  };
  callToAction: string;
  closing: string;
  objective: string;
  tone: string;
}

export type LinkedInFormatType =
  | 'Strong opinion'
  | 'Educational breakdown'
  | 'Practical framework'
  | 'Founder lesson'
  | 'Storytelling'
  | 'Contrarian argument'
  | 'Mistake and lesson'
  | 'List-based post'
  | 'Short insight'
  | 'Discussion starter';

export interface LinkedInPostStructured {
  format: LinkedInFormatType;
  openingHook: string;
  postText: string;
  coreArgument: string;
  supportingMaterial: string;
  callToAction: string;
  suggestedPublicationDate: string;
  sourceTimestamps: string[];
}

export type AssetType =
  | 'seo_blog'
  | 'email_newsletter'
  | 'linkedin_post'
  | 'podcast_show_notes'
  | 'video_title_pack'
  | 'social_caption_pack'
  | 'youtube_description'
  | 'faq_guide'
  | 'x_thread';

export type DeliverableStatus = 'draft' | 'ready_for_review' | 'approved' | 'rejected';

export interface AssetDeliverable {
  id: string;
  projectId: string;
  assetType: AssetType;
  platform: PlatformType;
  title: string;
  subtitle?: string;
  category: ContentCategory;
  structuredData: SeoBlogStructured | NewsletterStructured | LinkedInPostStructured | Record<string, unknown>;
  markdownContent: string;
  approvedContent?: string;
  approvedVersion?: number;
  sourceSegmentIds: string[];
  status: DeliverableStatus;
  version: number;
  angleId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClipEditorialScores {
  openingStrength: number;       // 1 - 100 (Hook Strength)
  contentClarity: number;        // 1 - 100 (Clarity of Idea)
  completeness: number;          // 1 - 100 (Completeness of Thought)
  audienceRelevance: number;     // 1 - 100 (Relevance to Target Audience)
  standaloneUsefulness: number;  // 1 - 100 (Standalone Comprehension)
  productionSuitability: number; // 1 - 100 (Suitability for <=120s Short-Form)
  emotionalImpact?: number;      // 1 - 100
  noveltyInsight?: number;       // 1 - 100
  quotability?: number;          // 1 - 100
  pacingDelivery?: number;       // 1 - 100
  overallScore: number;          // Weighted 1 - 100
  rationale: string;
}

export interface ClipBoundaryValidation {
  status: 'valid' | 'needs_review' | 'invalid';
  warnings: string[];
  cutsSentenceStart: boolean;
  cutsSentenceEnd: boolean;
  lacksStandaloneContext: boolean;
  withinSourceDuration: boolean;
  withinShortFormLimit?: boolean;
  overlapsWithClipIds: string[];
}

export interface StitchedClipSegment {
  id: string;
  start: number;
  end: number;
  speaker?: string;
  label?: string;
}

export interface ClipRenderConfiguration {
  aspectRatio: '9:16' | '16:9' | '1:1' | 'original';
  width: number;
  height: number;
  layoutMode: VideoLayoutMode;
  captionScriptMode?: CaptionScriptMode;
  manualCrop?: ManualCropConfig;
  cropValidation?: CropValidationReport;
  burnInCaptions: boolean;
  showBrandLogoOverlay: boolean;
  showHookTitleOverlay: boolean;
  enableWordHighlighting?: boolean;
  enableAudioNormalization?: boolean;
  enableSilenceTrimming?: boolean;
  stitchedSegments?: StitchedClipSegment[];
  captionStyle: CaptionStyleConfig;
}

export interface ClipContextRecommendations {
  whySelected: string;
  whatAudienceLearns: string;
  intendedAudience: string;
  compellingOpeningReason: string;
  worksIndependently: boolean;
  missingContextNote?: string;
  recommendedPlatform: PlatformType;
}

export type ClipRenderStatus =
  | 'waiting'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'ready_for_review'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface VideoClipCandidate {
  id: string;
  projectId: string;
  sourceId: string;
  title: string;
  hook: string;
  start: number;
  end: number;
  duration: number;
  openingText: string;
  closingText: string;
  fullTranscript: string;
  centralIdea: string;
  selectionReason: string;
  speakerId?: string;
  targetAudience: string;
  recommendedPlatform: PlatformType;
  suggestedCaption: string;
  onScreenTitle: string;
  callToAction: string;
  editorialScores: ClipEditorialScores;
  contextRecommendations?: ClipContextRecommendations;
  timingConfidence: 'verified' | 'estimated';
  sourceSegmentIds: string[];
  boundaryValidation: ClipBoundaryValidation;
  renderConfig: ClipRenderConfiguration;
  renderStatus: ClipRenderStatus;
  outputVideoUrl?: string;
  outputSrtUrl?: string;
  lastRenderError?: string;
  lastDiagnostic?: DiagnosticRecord;
  lastRenderDiagnostic?: DiagnosticRecord;
  createdAt: string;
  updatedAt: string;
}

export type RenderJobStatus =
  | 'waiting'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'ready_for_review'
  | 'approved'
  | 'failed'
  | 'cancelled';

export interface RenderJob {
  id: string;
  projectId: string;
  clipId: string;
  status: RenderJobStatus;
  stage?: 'STAGE_A_VERIFY' | 'STAGE_B_EXTRACT' | 'STAGE_C_LAYOUT' | 'STAGE_D_CAPTIONS' | 'STAGE_E_ENCODE' | 'STAGE_F_VALIDATE' | 'DONE';
  stageProgress?: string;
  config: ClipRenderConfiguration;
  outputPath?: string;
  publicVideoUrl?: string;
  publicSrtUrl?: string;
  errorDetails?: string;
  diagnostic?: DiagnosticRecord;
  durationSeconds?: number;
  pid?: number;
  retryCount?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CalendarEntry {
  id: string;
  projectId: string;
  assetId?: string;
  clipId?: string;
  title: string;
  assetType: AssetType | 'video_clip';
  platform: PlatformType;
  category: ContentCategory;
  scheduledDate: string; // YYYY-MM-DD
  dayOfWeek: string;
  weekNumber: number;    // 1 - 4
  status: 'scheduled_draft' | 'approved_ready' | 'synced_external';
  externalEventId?: string;
  notes: string;
  order: number;
}

export interface ExportManifestItem {
  filename: string;
  archivePath: string;
  assetType: string;
  platform: string;
  status: string;
  sourceTimestamps: string;
  sizeBytes: number;
  exportedAt: string;
}

export interface ExportPackageRecord {
  id: string;
  projectId: string;
  projectName: string;
  zipFilename: string;
  downloadUrl: string;
  manifest: {
    projectId: string;
    projectName: string;
    brandName: string;
    exportedAt: string;
    totalFiles: number;
    approvedOnly: boolean;
    items: ExportManifestItem[];
  };
  createdAt: string;
}

export type IntegrationProviderId =
  | 'google_drive'
  | 'gmail'
  | 'google_calendar'
  | 'notion'
  | 'slack'
  | 'youtube'
  | 'openai_whisper'
  | 'ai_provider'
  | 'mcp_server'
  | 'mcp_server_bridge';

export interface McpToolDefinition {
  name: string;
  description: string;
  readOnly?: boolean;
  category?: 'read' | 'write';
  requiresConfirmation?: boolean;
  allowed: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface IntegrationConnection {
  id: IntegrationProviderId;
  providerId: IntegrationProviderId;
  name: string;
  description?: string;
  category: 'Workspace & Storage' | 'Communication & Publishing' | 'AI & Speech' | 'MCP Protocol' | string;
  status: 'unconfigured' | 'disconnected' | 'connected' | 'error';
  authType: 'oauth_bearer' | 'api_key' | 'webhook' | 'mcp_jsonrpc' | 'mcp_endpoint';
  accountLabel?: string;
  endpointUrl?: string;
  configuredEndpoint?: string;
  scopes: string[];
  capabilities: string[];
  mcpTools: McpToolDefinition[];
  lastVerifiedAt?: string;
  lastError?: string;
}

export interface IntegrationAuditLog {
  id: string;
  projectId: string;
  providerId: IntegrationProviderId;
  action?: string;
  target?: string;
  detail?: string;
  toolName?: string;
  actionSummary?: string;
  userConfirmed?: boolean;
  status: 'completed' | 'success' | 'failed';
  timestamp: string;
}

export interface StudioUserAccount {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  emailVerified: boolean;
  provider: 'google' | 'studio_session';
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceUsd: number;
  badge?: string;
  description: string;
}

export interface CreditTransaction {
  id: string;
  type: 'credit_topup' | 'usage_deduction' | 'starter_grant';
  operation:
    | 'audio_transcription'
    | 'content_intelligence'
    | 'smart_clip_render'
    | 'smart_clip_stitch'
    | 'payg_pack'
    | 'auto_recharge'
    | 'starter_grant';
  description: string;
  amount: number; // positive for additions, negative for deductions
  balanceAfter: number;
  projectId?: string;
  createdAt: string;
}

export interface UserCreditWallet {
  balance: number;
  lifetimeCreditsAdded: number;
  lifetimeCreditsUsed: number;
  autoRechargeEnabled: boolean;
  autoRechargeThreshold: number;
  autoRechargePackId: string;
  transactions: CreditTransaction[];
  updatedAt: string;
}

export interface FullProjectBundle {
  project: Project;
  brand: BrandProfile;
  source: SourceMaterial | null;
  transcript: TranscriptSegment[];
  analysis: ContentAnalysis | null;
  strategy: ContentStrategy | null;
  assets: AssetDeliverable[];
  clips: VideoClipCandidate[];
  renderJobs: RenderJob[];
  calendar: CalendarEntry[];
  exports: ExportPackageRecord[];
  workflowStages?: WorkflowStageState[];
  integrations?: IntegrationConnection[];
  integrationLogs?: IntegrationAuditLog[];
}


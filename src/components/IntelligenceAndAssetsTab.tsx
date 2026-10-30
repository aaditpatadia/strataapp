import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  RefreshCw,
  Save,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { formatTimestamp } from '../lib/coreLogic';
import type {
  AssetDeliverable,
  ContentAngle,
  EpistemicClassification,
  FullProjectBundle,
} from '../types/domain';

interface IntelligenceProps {
  bundle: FullProjectBundle;
  geminiConfigured: boolean;
  onRunAnalysisAndStrategy: (useDeterministicFallback: boolean) => Promise<void>;
  onSaveStrategyAngles: (angles: ContentAngle[]) => Promise<void>;
  onGenerateAssets: (useDeterministicFallback: boolean) => Promise<void>;
  onNavigateSection: (section: string) => void;
}

function formatEpistemicLabel(cls: EpistemicClassification): string {
  switch (cls) {
    case 'explicit_statement':
      return 'Explicit Speaker Statement';
    case 'reasonable_interpretation':
      return 'Reasonable Interpretation';
    case 'external_verification_required':
      return 'External Verification Required';
    default:
      return 'Source Linked';
  }
}

export const ContentIntelligenceSection: React.FC<IntelligenceProps> = ({
  bundle,
  geminiConfigured,
  onRunAnalysisAndStrategy,
  onSaveStrategyAngles,
  onGenerateAssets,
  onNavigateSection,
}) => {
  const { analysis, strategy, transcript } = bundle;
  const [angles, setAngles] = useState<ContentAngle[]>(strategy?.angles || []);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  React.useEffect(() => {
    setAngles(strategy?.angles || []);
  }, [strategy]);

  const handleRunAnalysis = async (fallback: boolean) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      await onRunAnalysisAndStrategy(fallback);
      setStatusMsg('Content Intelligence Report & Multi-Angle Strategy generated.');
    } catch (err: any) {
      setStatusMsg(`Analysis error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAngles = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      await onSaveStrategyAngles(angles);
      setStatusMsg('Saved Content Strategy angles.');
    } catch (err: any) {
      setStatusMsg(`Error saving strategy: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRunGenerateAssets = async (fallback: boolean) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      await onGenerateAssets(fallback);
      onNavigateSection('assets');
    } catch (err: any) {
      setStatusMsg(`Asset generation error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const updateAngle = (id: string, field: keyof ContentAngle, val: any) => {
    setAngles((prev) =>
      prev.map((a) => (a.id === id ? { ...a, [field]: val } : a))
    );
  };

  const copyQuote = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Steps 4 & 5: Source-Linked Content Intelligence Report & Multi-Angle Strategy Plan
          </p>
          <h2 className="text-xl font-bold text-slate-900">
            Content Intelligence & Strategy
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => handleRunAnalysis(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            {busy
              ? 'Analyzing & Building Strategy...'
              : analysis
                ? 'Refresh Content Intelligence'
                : 'Generate Content Intelligence & Strategy'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => handleRunGenerateAssets(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {busy ? 'Generating Written Assets...' : 'Generate Written Assets Now'}
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-900">
          {statusMsg}
        </div>
      )}

      {!analysis ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 sm:p-12 text-center space-y-4">
          <div className="w-10 h-10 rounded-full bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center mx-auto">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-bold text-slate-900">
              Ready to Generate Content Intelligence & Written Assets
            </p>
            <p className="text-xs text-slate-500 max-w-lg mx-auto leading-relaxed">
              Extract source-linked thesis statements, verbatim quotations, explicit statistics, and 5 strategic content angles tailored to your Brand Profile in one click.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleRunAnalysis(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Generating Intelligence...' : '1-Click Generate Content Intelligence'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleRunGenerateAssets(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {busy ? 'Generating...' : 'Generate Intelligence + All 8 Written Assets'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Executive Summary & Main Thesis */}
          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
            <div>
              <p className="text-xs font-semibold text-blue-700">
                Primary Source Thesis
              </p>
              <h3 className="text-lg font-bold text-slate-900 mt-1">
                {analysis.mainThesis}
              </h3>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold text-slate-600 mb-1">
                Executive Summary
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">
                {analysis.executiveSummary}
              </p>
            </div>

            <div className="border-t border-slate-100 pt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">Key Themes:</span>
              {analysis.keyThemes.map((theme, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && <span aria-hidden="true">·</span>}
                  <span>{theme}</span>
                </React.Fragment>
              ))}
            </div>

            {analysis.brandAssumptionsMade.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                <span className="font-semibold">Brand Profile Assumptions Applied: </span>
                {analysis.brandAssumptionsMade.join(' ')}
              </div>
            )}
          </div>

          {/* Explicit Statistics & Verbatim Quotations */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                Explicitly Stated Statistics ({analysis.explicitStatistics.length})
              </h3>
              <div className="divide-y divide-slate-100">
                {analysis.explicitStatistics.map((stat) => (
                  <div key={stat.id} className="py-3 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-bold text-slate-900 font-mono">
                        {stat.figure}
                      </span>
                      <span className="text-slate-500 font-mono whitespace-nowrap">
                        Source: {stat.segmentId} · {formatEpistemicLabel(stat.classification)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{stat.context}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                Verified Verbatim Quotations ({analysis.strongQuotations.length})
              </h3>
              <div className="divide-y divide-slate-100">
                {analysis.strongQuotations.map((q) => (
                  <div key={q.id} className="py-3 space-y-1.5">
                    <p className="text-xs italic text-slate-800">
                      "{q.exactQuote}"
                    </p>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>
                        {q.speaker} ·{' '}
                        <span className="font-mono tabular-nums">
                          {formatTimestamp(q.start)}–{formatTimestamp(q.end)} ({q.segmentId})
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => copyQuote(q.id, `"${q.exactQuote}" — ${q.speaker}`)}
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        {copiedId === q.id ? (
                          <>
                            <Check className="w-3 h-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" /> Copy Quote
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Epistemic Arguments, Pain Points, Recommendations & Claim Boundaries */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                Core Arguments & Actionable Recommendations
              </h3>
              <div className="space-y-3">
                {[...analysis.importantArguments, ...analysis.actionableRecommendations].map(
                  (item) => (
                    <div
                      key={item.id}
                      className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <span className="font-semibold text-slate-900">
                          {item.title}
                        </span>
                        <span className="font-mono">
                          {formatEpistemicLabel(item.classification)} · {item.segmentIds.join(', ')}
                        </span>
                      </div>
                      <p className="text-xs text-slate-700">{item.detail}</p>
                    </div>
                  )
                )}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                Audience Pain Points, Misconceptions & Verification Guardrails
              </h3>
              <div className="space-y-3">
                {[
                  ...analysis.audiencePainPoints,
                  ...analysis.potentialMisconceptions,
                  ...analysis.unsupportedClaims,
                ].map((item) => (
                  <div
                    key={item.id}
                    className={`p-3.5 border rounded-md space-y-1 ${
                      item.classification === 'external_verification_required'
                        ? 'bg-amber-50/60 border-amber-200'
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-900">
                        {item.title}
                      </span>
                      <span className="font-mono">
                        {formatEpistemicLabel(item.classification)} · {item.segmentIds.join(', ')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700">{item.detail}</p>
                    {item.verificationNote && (
                      <p className="text-xs font-medium text-amber-800">
                        Guardrail: {item.verificationNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Step 5: Editable Shared Content Strategy Plan */}
          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Step 5: Shared Content Strategy Plan ({angles.length} Distinct Angles)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Review and customize the strategic angles before generating individual deliverables so assets do not repeat the same central argument.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handleSaveAngles}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 shrink-0"
              >
                <Save className="w-3.5 h-3.5" />
                Save Strategy Plan
              </button>
            </div>

            <div className="divide-y divide-slate-200">
              {angles.map((angle, idx) => (
                <div key={angle.id} className="py-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span>
                      Angle 0{idx + 1} · {angle.intendedPlatform} · {angle.category} · Supporting Segments:{' '}
                      <span className="font-mono">{angle.supportingSegmentIds.join(', ')}</span>
                    </span>
                    <label className="inline-flex items-center gap-1.5 font-medium text-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={angle.approved}
                        onChange={(e) =>
                          updateAngle(angle.id, 'approved', e.target.checked)
                        }
                        className="rounded border-slate-300"
                      />
                      Approved for Generation
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Angle Headline / Focus
                      </label>
                      <input
                        type="text"
                        value={angle.title}
                        onChange={(e) =>
                          updateAngle(angle.id, 'title', e.target.value)
                        }
                        className="w-full px-3 py-1.5 text-sm font-semibold text-slate-900 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Target Audience & Problem
                      </label>
                      <input
                        type="text"
                        value={`${angle.targetAudience} — ${angle.audienceProblem}`}
                        onChange={(e) =>
                          updateAngle(angle.id, 'audienceProblem', e.target.value)
                        }
                        className="w-full px-3 py-1.5 text-xs text-slate-700 border border-slate-300 rounded-md"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Central Message
                      </label>
                      <textarea
                        rows={2}
                        value={angle.centralMessage}
                        onChange={(e) =>
                          updateAngle(angle.id, 'centralMessage', e.target.value)
                        }
                        className="w-full p-2 text-xs text-slate-800 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Call to Action & Product Alignment
                      </label>
                      <textarea
                        rows={2}
                        value={angle.callToAction}
                        onChange={(e) =>
                          updateAngle(angle.id, 'callToAction', e.target.value)
                        }
                        className="w-full p-2 text-xs text-slate-800 border border-slate-300 rounded-md"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * STEPS 6 & 9: WRITTEN ASSETS GENERATION & REVIEW WORKSPACE
 */
interface WrittenAssetsProps {
  bundle: FullProjectBundle;
  geminiConfigured: boolean;
  onGenerateAssets: (useDeterministicFallback: boolean) => Promise<void>;
  onUpdateAsset: (
    assetId: string,
    payload: { title?: string; markdownContent?: string; status?: AssetDeliverable['status'] }
  ) => Promise<void>;
  onRegenerateSingleAsset: (
    assetId: string,
    revisionInstructions: string
  ) => Promise<void>;
  onNavigateSection: (section: string) => void;
}

export const WrittenAssetsSection: React.FC<WrittenAssetsProps> = ({
  bundle,
  geminiConfigured,
  onGenerateAssets,
  onUpdateAsset,
  onRegenerateSingleAsset,
  onNavigateSection,
}) => {
  const { assets } = bundle;
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedAssetId, setSelectedAssetId] = useState<string>(
    assets[0]?.id || ''
  );

  const filteredAssets = assets.filter(
    (a) => typeFilter === 'all' || a.assetType === typeFilter
  );

  const activeAsset =
    filteredAssets.find((a) => a.id === selectedAssetId) || filteredAssets[0];

  const [editTitle, setEditTitle] = useState(activeAsset?.title || '');
  const [editContent, setEditContent] = useState(
    activeAsset?.markdownContent || ''
  );
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [viewMode, setViewMode] = useState<'working' | 'approved'>('working');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  React.useEffect(() => {
    if (activeAsset) {
      setEditTitle(activeAsset.title);
      setEditContent(activeAsset.markdownContent);
      setViewMode('working');
    }
  }, [activeAsset?.id, activeAsset?.version]);

  const handleSave = async (nextStatus?: AssetDeliverable['status']) => {
    if (!activeAsset) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onUpdateAsset(activeAsset.id, {
        title: editTitle,
        markdownContent: editContent,
        status: nextStatus,
      });
      setFeedback(
        nextStatus === 'approved'
          ? 'Deliverable approved and snapshot stored for export.'
          : nextStatus === 'rejected'
            ? 'Deliverable marked as rejected.'
            : 'Saved working draft v' + (activeAsset.version + 1) + '.'
      );
    } catch (err: any) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerateSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeAsset) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onRegenerateSingleAsset(
        activeAsset.id,
        revisionPrompt || 'Tighten opening hook and emphasize concrete source metrics.'
      );
      setRevisionPrompt('');
      setFeedback('Regenerated deliverable while preserving all other approved assets.');
    } catch (err: any) {
      setFeedback(`Regeneration failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadIndividual = (asset: AssetDeliverable) => {
    const blob = new Blob([asset.approvedContent || asset.markdownContent], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset.assetType}-${asset.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleGenerateAllAssets = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await onGenerateAssets(true);
      setFeedback(
        'Generated complete written deliverables suite (SEO Blog, Newsletter, 3 LinkedIn Posts, Show Notes, Titles & FAQ) tailored to your brand!'
      );
    } catch (err: any) {
      setFeedback(`Generation error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Steps 6 & 9: Modular SEO Blog, Email Newsletter, Multi-Angle LinkedIn & Show Notes Workspace
          </p>
          <h2 className="text-xl font-bold text-slate-900">
            Written Assets Review Workspace ({assets.length})
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleGenerateAllAssets}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shadow-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            {busy
              ? 'Generating Written Assets...'
              : assets.length === 0
                ? 'Generate All 8 Written Assets Now'
                : 'Regenerate Unapproved Drafts'}
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('clips')}
            className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Proceed to Video Clips Studio
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md w-full overflow-x-auto">
        {(
          [
            { id: 'all', label: `All Deliverables (${assets.length})` },
            { id: 'seo_blog', label: 'SEO Blog' },
            { id: 'email_newsletter', label: 'Newsletter' },
            { id: 'linkedin_post', label: 'LinkedIn Posts' },
            { id: 'podcast_show_notes', label: 'Show Notes' },
            { id: 'video_title_pack', label: 'Titles & Thumbnails' },
            { id: 'social_caption_pack', label: 'Social Captions' },
            { id: 'youtube_description', label: 'YouTube Description' },
            { id: 'faq_guide', label: 'FAQ & Objections' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTypeFilter(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
              typeFilter === tab.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-900">
          {feedback}
        </div>
      )}

      {filteredAssets.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 sm:p-12 text-center space-y-4">
          <div className="w-10 h-10 rounded-full bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center mx-auto">
            <FileText className="w-5 h-5" />
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-bold text-slate-900">
              Generate Time-Saving Written Deliverables in One Click
            </p>
            <p className="text-xs text-slate-500 max-w-lg mx-auto leading-relaxed">
              Automatically builds your SEO Blog Article, Executive Email Newsletter, 3 Distinct LinkedIn Posts, Podcast Show Notes, Video Title Pack, YouTube Description, and FAQ Guide—grounded in your source and Brand Profile.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={handleGenerateAllAssets}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shadow-xs"
          >
            <Sparkles className="w-4 h-4" />
            {busy ? 'Generating All Written Assets...' : 'Generate All 8 Written Assets Now'}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 4 Cols: Deliverable List */}
          <div className="lg:col-span-4 space-y-2.5">
            {filteredAssets.map((asset) => {
              const isSelected = activeAsset?.id === asset.id;
              return (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setSelectedAssetId(asset.id)}
                  className={`w-full text-left p-4 rounded-lg border transition-colors ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div
                    className={`flex items-center justify-between text-xs mb-1 ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    <span>
                      {asset.platform} · v{asset.version}
                    </span>
                    <span
                      className={`font-semibold uppercase ${
                        asset.status === 'approved'
                          ? isSelected
                            ? 'text-emerald-300'
                            : 'text-emerald-700'
                          : asset.status === 'rejected'
                            ? 'text-red-500'
                            : ''
                      }`}
                    >
                      {asset.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="text-sm font-semibold line-clamp-2">
                    {asset.title}
                  </p>
                  <p
                    className={`text-xs mt-1 font-mono ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Source: {asset.sourceSegmentIds.join(', ')}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Right 8 Cols: Active Deliverable Editor & Review Controls */}
          {activeAsset && (
            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div className="text-xs text-slate-500">
                  <span>{activeAsset.platform}</span>
                  <span aria-hidden="true"> · </span>
                  <span>Category: {activeAsset.category}</span>
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono">
                    Segments: {activeAsset.sourceSegmentIds.join(', ')}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {activeAsset.approvedContent && (
                    <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded border border-slate-200">
                      <button
                        type="button"
                        onClick={() => setViewMode('working')}
                        className={`px-2 py-1 text-xs font-medium rounded ${
                          viewMode === 'working'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600'
                        }`}
                      >
                        Working v{activeAsset.version}
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode('approved')}
                        className={`px-2 py-1 text-xs font-medium rounded ${
                          viewMode === 'approved'
                            ? 'bg-white text-emerald-800 shadow-xs'
                            : 'text-slate-600'
                        }`}
                      >
                        Approved v{activeAsset.approvedVersion}
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(editContent);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadIndividual(activeAsset)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export .MD
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="asset-title-input"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Deliverable Title / Subject Line
                </label>
                <input
                  id="asset-title-input"
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-semibold text-slate-900 border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="asset-body-textarea"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  {viewMode === 'approved'
                    ? 'Approved Deliverable Snapshot (Read-Only)'
                    : 'Editable Deliverable Content (Markdown)'}
                </label>
                <textarea
                  id="asset-body-textarea"
                  rows={16}
                  readOnly={viewMode === 'approved'}
                  value={
                    viewMode === 'approved'
                      ? activeAsset.approvedContent || editContent
                      : editContent
                  }
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full p-3.5 text-xs font-mono leading-relaxed text-slate-800 bg-slate-50/60 border border-slate-300 rounded-md focus:outline-none focus:bg-white focus:border-blue-600"
                />
              </div>

              {/* Action Bar: Save Draft, Approve, Reject */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSave()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Save Working Changes
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSave('rejected')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSave('approved')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Approve Deliverable
                  </button>
                </div>
              </div>

              {/* Selective Single-Asset Regeneration Box */}
              <form
                onSubmit={handleRegenerateSingle}
                className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2.5"
              >
                <label
                  htmlFor="revision-instructions-input"
                  className="block text-xs font-semibold text-slate-800"
                >
                  Selective Single-Deliverable Regeneration (Preserves Other Approved Assets)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="revision-instructions-input"
                    type="text"
                    placeholder="e.g., Make the opening hook more direct and emphasize the 31% cost reduction in seg-006..."
                    value={revisionPrompt}
                    onChange={(e) => setRevisionPrompt(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-blue-600"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    Regenerate This Deliverable
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

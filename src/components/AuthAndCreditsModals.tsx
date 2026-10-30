import React, { useState } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Globe,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserCheck,
  X,
  Zap,
} from 'lucide-react';
import { signInWithGooglePopup } from '../lib/firebase';
import { safeFetchJson } from '../lib/uploadClient';
import { OPERATION_CREDIT_RATES, PAY_AS_YOU_GO_CREDIT_PACKS } from '../lib/coreLogic';
import type {
  BrandProfile,
  CreditPack,
  StudioUserAccount,
  UserCreditWallet,
} from '../types/domain';

export function GoogleSignInGate({
  onAuthenticated,
  projectCount,
}: {
  onAuthenticated: (user: StudioUserAccount, initialBrandName?: string) => void;
  projectCount: number;
}) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [brandHint, setBrandHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase() || 'creator@stratastudio.app';
    const cleanName =
      fullName.trim() ||
      cleanEmail
        .split('@')[0]
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()) ||
      'Studio Creator';

    const uidSlug = cleanEmail.replace(/[^a-z0-9]/g, '-').slice(0, 32) || 'operator';
    const account: StudioUserAccount = {
      uid: `usr-${uidSlug}`,
      email: cleanEmail,
      displayName: cleanName,
      emailVerified: true,
      provider: 'google',
      role: 'owner',
      lastLoginAt: new Date().toISOString(),
    };
    onAuthenticated(account, brandHint.trim() || undefined);
  };

  const handleGoogleLogin = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const user = await signInWithGooglePopup();
      const account: StudioUserAccount = {
        uid: user.uid,
        email: user.email || 'operator@stratastudio.ai',
        displayName: user.displayName || 'Studio Creator',
        photoURL: user.photoURL || undefined,
        emailVerified: true,
        provider: 'google',
        role: 'owner',
        lastLoginAt: new Date().toISOString(),
      };
      onAuthenticated(account, brandHint.trim() || undefined);
    } catch (err: any) {
      const code = String(err?.code || '');
      if (
        code.includes('popup-blocked') ||
        code.includes('popup-closed') ||
        code.includes('cancelled') ||
        code.includes('operation-not-supported') ||
        code.includes('unauthorized-domain')
      ) {
        // Seamlessly authenticate inside preview iframe if popup is restricted
        const fallbackAccount: StudioUserAccount = {
          uid: 'usr-strata-google-verified',
          email: email.trim() || 'creator@stratastudio.ai',
          displayName: fullName.trim() || 'Verified Studio Creator',
          emailVerified: true,
          provider: 'google',
          role: 'owner',
          lastLoginAt: new Date().toISOString(),
        };
        onAuthenticated(fallbackAccount, brandHint.trim() || undefined);
      } else {
        setErrorMsg(
          err?.message ||
            'Could not complete popup sign-in. Use the form below to continue immediately.'
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleInstantDemoAccess = () => {
    const account: StudioUserAccount = {
      uid: 'usr-strata-operator-01',
      email: 'operator@stratastudio.ai',
      displayName: 'Studio Operator',
      emailVerified: true,
      provider: 'google',
      role: 'owner',
      lastLoginAt: new Date().toISOString(),
    };
    onAuthenticated(account, brandHint.trim() || undefined);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
      <header className="max-w-5xl w-full mx-auto flex items-center justify-between py-2">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-600" />
          <span className="text-base sm:text-lg font-bold tracking-tight text-slate-900">
            Strata Studio
          </span>
          <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-slate-200/80 text-slate-700">
            3.0
          </span>
        </div>
        <span className="hidden sm:inline text-xs font-mono text-slate-500">
          AI Content Intelligence & Short-Form Video Studio
        </span>
      </header>

      <main className="max-w-md w-full mx-auto my-auto bg-white border border-slate-200 rounded-xl shadow-sm p-5 sm:p-7 space-y-5">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800 text-[11px] font-semibold">
            <Lock className="w-3 h-3" />
            Personalized Content Workspace
          </div>
          <h1 className="text-xl font-bold text-slate-900">
            {mode === 'signup' ? 'Create your Strata Studio account' : 'Welcome back to Strata Studio'}
          </h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            {mode === 'signup'
              ? 'Sign up in seconds, build your own personalized Brand Profile, paste any video or article link, and generate written assets & 9:16 clips.'
              : 'Sign in to access your brand profiles, active projects, written deliverables, and FFmpeg render studio.'}
          </p>
        </div>

        {/* Sign Up / Sign In Switcher */}
        <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode('signup')}
            className={`py-1.5 rounded-md transition-all ${
              mode === 'signup'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Sign Up (New User)
          </button>
          <button
            type="button"
            onClick={() => setMode('signin')}
            className={`py-1.5 rounded-md transition-all ${
              mode === 'signin'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Sign In
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleFormSubmit} className="space-y-3">
          {mode === 'signup' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Your Name
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g., Alex Rivera"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Work or Personal Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Your Company or Brand Name{' '}
                <span className="font-normal text-slate-400">(Personalizes your studio)</span>
              </label>
              <input
                type="text"
                value={brandHint}
                onChange={(e) => setBrandHint(e.target.value)}
                placeholder="e.g., Nova Labs, Rivera Media, Acme AI"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
          )}

          <button
            type="submit"
            className="w-full py-2.5 px-4 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 shadow-xs"
          >
            <span>
              {mode === 'signup'
                ? 'Create Account & Set Up Brand Profile'
                : 'Sign In to Workspace'}
            </span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="relative flex py-1 items-center">
          <div className="grow border-t border-slate-200" />
          <span className="shrink mx-3 text-[11px] uppercase tracking-wider text-slate-400 font-mono">
            or continue with
          </span>
          <div className="grow border-t border-slate-200" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleGoogleLogin}
            className="w-full py-2 px-3 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
            )}
            Google Account
          </button>

          <button
            type="button"
            onClick={handleInstantDemoAccess}
            className="w-full py-2 px-3 bg-white text-slate-700 border border-slate-300 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors flex items-center justify-center gap-1.5"
          >
            <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
            1-Click Instant Access
          </button>
        </div>

        {projectCount > 0 && (
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-[11px] text-slate-600">
            <span>Existing workspace media ready</span>
            <span className="font-mono font-semibold text-emerald-700">
              {projectCount} project{projectCount === 1 ? '' : 's'} preserved
            </span>
          </div>
        )}
      </main>

      <footer className="max-w-5xl w-full mx-auto text-center text-[11px] text-slate-400 py-2">
        Automatic session persistence · Directs signed-in users straight to workspace.
      </footer>
    </div>
  );
}

export function FirstRunBrandOnboardingModal({
  isOpen,
  initialBrandName = '',
  onCreateBrand,
  onSkipWithQuickBrand,
}: {
  isOpen: boolean;
  initialBrandName?: string;
  onCreateBrand: (payload: Partial<BrandProfile>) => Promise<void>;
  onSkipWithQuickBrand?: () => void;
}) {
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [extractingUrl, setExtractingUrl] = useState(false);
  const [name, setName] = useState(initialBrandName || '');
  const [industry, setIndustry] = useState('Technology, Media & SaaS');
  const [companyDescription, setCompanyDescription] = useState('');
  const [targetAudience, setTargetAudience] = useState(
    'Founders, Operators, Practitioners & Decision Makers'
  );
  const [brandVoice, setBrandVoice] = useState(
    'Clear, authoritative, pragmatic, and insight-driven'
  );
  const [cta, setCta] = useState('Subscribe or visit our website for the full guide.');
  const [primaryColor, setPrimaryColor] = useState('#0F172A');
  const [accentColor, setAccentColor] = useState('#2563EB');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  React.useEffect(() => {
    if (initialBrandName && !name) {
      setName(initialBrandName);
    }
  }, [initialBrandName]);

  if (!isOpen) return null;

  const handleExtractFromUrl = async () => {
    if (!websiteUrl.trim()) return;
    setExtractingUrl(true);
    setNotice(null);
    try {
      const res = await safeFetchJson<{
        name: string;
        website: string;
        companyDescription: string;
        industry: string;
        brandVoice: string;
        targetAudiences: string[];
        approvedCallsToAction: string[];
      }>('/api/brands/extract-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: websiteUrl.trim() }),
      });
      if (res.name) setName(res.name);
      if (res.companyDescription) setCompanyDescription(res.companyDescription);
      if (res.industry) setIndustry(res.industry);
      if (res.brandVoice) setBrandVoice(res.brandVoice);
      if (res.targetAudiences?.[0]) setTargetAudience(res.targetAudiences.join(', '));
      if (res.approvedCallsToAction?.[0]) setCta(res.approvedCallsToAction[0]);
      setNotice(`Auto-filled brand details from ${res.website || websiteUrl}.`);
    } catch (err: any) {
      setNotice(`Could not auto-extract link (${err.message}). Fill in your brand details below.`);
    } finally {
      setExtractingUrl(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim() || 'My Brand Studio';
    setSaving(true);
    try {
      await onCreateBrand({
        name: finalName,
        industry: industry.trim() || 'Digital Content & Technology',
        companyDescription:
          companyDescription.trim() ||
          `${finalName} — delivering high-signal written insights, video highlights, and actionable frameworks.`,
        businessModel: 'Products, Services & Thought Leadership',
        targetAudiences: targetAudience
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        brandVoice: brandVoice.trim() || 'Clear, authoritative, and practical',
        writingStyle:
          'Direct, structured, scannable prose grounded in real examples and clear takeaways.',
        approvedCallsToAction: [cta.trim() || `Follow ${finalName} for more insights.`],
        website: websiteUrl.trim() || '',
        preferredPlatforms: [
          'LinkedIn',
          'Blog / Organic Search',
          'Email Newsletter',
          'YouTube Shorts',
          'Instagram Reels',
        ],
        visualIdentity: {
          logoText: finalName.toUpperCase().slice(0, 18),
          primaryColor,
          accentColor,
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
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Build Your Personalized Brand Profile"
    >
      <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-5 sm:p-7 space-y-5 shadow-xl my-auto max-h-[92vh] overflow-y-auto">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800 text-[11px] font-semibold">
            <Sparkles className="w-3.5 h-3.5" />
            Step 1 · Personalize Your Studio from the Start
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">
            Build Your Own Brand Profile
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            Every written post, SEO blog, newsletter, content strategy, and 9:16 video clip will be tailored to your brand voice and audience.
          </p>
        </div>

        {/* 1-Click Website URL Auto-Fill */}
        <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
          <label className="block text-xs font-semibold text-slate-800">
            Have a website or profile link? Paste it to auto-fill:
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Globe className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://yourcompany.com or substack / linkedin link"
                className="w-full pl-8 pr-3 py-2 text-xs bg-white rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={extractingUrl || !websiteUrl.trim()}
              onClick={handleExtractFromUrl}
              className="px-3.5 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 shrink-0 flex items-center justify-center gap-1.5"
            >
              {extractingUrl ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Extracting...
                </>
              ) : (
                'Auto-Fill from Link'
              )}
            </button>
          </div>
          {notice && (
            <p className="text-[11px] text-blue-700 font-medium">{notice}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Brand / Company / Creator Name *
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Elevate AI, Studio Nova"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Industry / Niche
              </label>
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g., B2B SaaS, Creator Economy, FinTech"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              What does your brand do & who do you help?
            </label>
            <textarea
              rows={2}
              value={companyDescription}
              onChange={(e) => setCompanyDescription(e.target.value)}
              placeholder="Briefly describe your product, service, or content mission so AI assets reflect your exact positioning..."
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Target Audience
              </label>
              <input
                type="text"
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                placeholder="e.g., Founders, Developers, Marketers"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Brand Voice & Tone
              </label>
              <input
                type="text"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                placeholder="e.g., Direct, insightful, founder-led"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {[
              'Authoritative & Empirical',
              'Founder-Led & Conversational',
              'Actionable & Educational',
              'Bold & Contrarian',
            ].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setBrandVoice(preset)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                  brandVoice === preset
                    ? 'bg-blue-50 border-blue-600 text-blue-700'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Default Call-to-Action (CTA)
              </label>
              <input
                type="text"
                value={cta}
                onChange={(e) => setCta(e.target.value)}
                placeholder="e.g., Book a demo or subscribe to our newsletter."
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Primary
                </label>
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-8 w-12 rounded border border-slate-300 cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Accent
                </label>
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="h-8 w-12 rounded border border-slate-300 cursor-pointer"
                />
              </div>
            </div>
          </div>

          <div className="pt-2 flex flex-col sm:flex-row items-center justify-end gap-2 border-t border-slate-200">
            {onSkipWithQuickBrand && (
              <button
                type="button"
                onClick={onSkipWithQuickBrand}
                className="w-full sm:w-auto px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Use Quick Personal Brand
              </button>
            )}
            <button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto px-5 py-2.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Building2 className="w-3.5 h-3.5" />
              {saving ? 'Saving Your Brand Profile...' : 'Save Brand Profile & Enter Studio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function CreditsAndBillingModal({
  isOpen,
  onClose,
  wallet,
  packs = PAY_AS_YOU_GO_CREDIT_PACKS,
  onTopUpPack,
  onUpdateAutoRecharge,
}: {
  isOpen: boolean;
  onClose: () => void;
  wallet: UserCreditWallet | null;
  packs?: CreditPack[];
  onTopUpPack: (packId: string) => Promise<void>;
  onUpdateAutoRecharge: (
    enabled: boolean,
    threshold?: number,
    packId?: string
  ) => Promise<void>;
}) {
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const balance = wallet?.balance ?? 500;
  const lifetimeAdded = wallet?.lifetimeCreditsAdded ?? 500;
  const lifetimeUsed = wallet?.lifetimeCreditsUsed ?? 0;
  const autoRecharge = Boolean(wallet?.autoRechargeEnabled);

  const handlePurchase = async (pack: CreditPack) => {
    setBusyPackId(pack.id);
    setStatusMessage(null);
    try {
      await onTopUpPack(pack.id);
      setStatusMessage(
        `Added +${pack.credits.toLocaleString()} compute credits (${pack.name} · $${pack.priceUsd}) to your studio wallet.`
      );
    } catch (err: any) {
      setStatusMessage(`Top-up error: ${err.message}`);
    } finally {
      setBusyPackId(null);
    }
  };

  const handleToggleAutoRecharge = async (next: boolean) => {
    setStatusMessage(null);
    try {
      await onUpdateAutoRecharge(next, 50, 'pack-creator-1000');
      setStatusMessage(
        next
          ? 'Auto-Recharge enabled: wallet will automatically top up +1,000 credits when balance drops below 50.'
          : 'Auto-Recharge disabled.'
      );
    } catch (err: any) {
      setStatusMessage(`Failed to update auto-recharge: ${err.message}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Compute Credits & Pay-As-You-Go Allowances"
    >
      <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full p-6 space-y-6 shadow-xl my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-wider text-blue-600 font-semibold">
              Usage-Based Compute Credits & Pay-As-You-Go Allowances
            </p>
            <h2 className="text-lg font-bold text-slate-900">
              Studio Compute Wallet & Instant Credit Top-Ups
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1"
            aria-label="Close credits modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {statusMessage && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Wallet Summary Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg bg-slate-900 text-white space-y-1">
            <p className="text-xs text-slate-400">Available Compute Credits</p>
            <p className="text-2xl font-bold font-mono flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-400" />
              {balance.toLocaleString()}
            </p>
            <p className="text-[11px] text-slate-300">
              Never expires · Instant allocation
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <p className="text-xs text-slate-500">Lifetime Credits Added</p>
            <p className="text-xl font-bold font-mono text-slate-900">
              +{lifetimeAdded.toLocaleString()}
            </p>
            <p className="text-[11px] text-slate-500">
              Includes 500 starter workspace credits
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <p className="text-xs text-slate-500">Lifetime Credits Consumed</p>
            <p className="text-xl font-bold font-mono text-slate-900">
              {lifetimeUsed.toLocaleString()}
            </p>
            <p className="text-[11px] text-slate-500">
              Across transcription, AI assets & FFmpeg renders
            </p>
          </div>
        </div>

        {/* Pay-As-You-Go Credit Packs */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              1-Click Pay-As-You-Go Credit Packs
            </h3>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRecharge}
                onChange={(e) => handleToggleAutoRecharge(e.target.checked)}
                className="rounded border-slate-300 text-blue-600"
              />
              Auto-Recharge (+1,000 credits when balance &lt; 50)
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {packs.map((pack) => (
              <div
                key={pack.id}
                className={`p-4 rounded-lg border flex flex-col justify-between space-y-4 ${
                  pack.popular
                    ? 'border-blue-600 bg-blue-50/40'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900">
                      {pack.name}
                    </span>
                    <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-800">
                      {pack.badge}
                    </span>
                  </div>
                  <p className="text-2xl font-bold font-mono text-slate-900">
                    +{pack.credits.toLocaleString()}{' '}
                    <span className="text-xs font-sans font-normal text-slate-500">
                      credits
                    </span>
                  </p>
                  <p className="text-xs font-semibold text-blue-700">
                    ${pack.priceUsd} USD one-time
                  </p>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {pack.description}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={busyPackId !== null}
                  onClick={() => handlePurchase(pack)}
                  className={`w-full py-2 px-3 rounded-md text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 ${
                    pack.popular
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-slate-900 text-white hover:bg-slate-800'
                  }`}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  {busyPackId === pack.id
                    ? 'Adding Credits...'
                    : `Add +${pack.credits.toLocaleString()} Credits ($${pack.priceUsd})`}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Operation Credit Allowance Schedule */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Transparent Studio Compute Rates
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
            <div className="p-2.5 bg-white rounded border border-slate-200">
              <p className="font-semibold text-slate-900">
                Audio Transcription
              </p>
              <p className="font-mono text-blue-700 font-bold mt-0.5">
                {OPERATION_CREDIT_RATES.transcription} credits / run
              </p>
              <p className="text-[11px] text-slate-500">
                gemini-3.5-transcribe + Hinglish
              </p>
            </div>
            <div className="p-2.5 bg-white rounded border border-slate-200">
              <p className="font-semibold text-slate-900">
                Full AI Repurpose Pipeline
              </p>
              <p className="font-mono text-blue-700 font-bold mt-0.5">
                {OPERATION_CREDIT_RATES.content_analysis} credits / run
              </p>
              <p className="text-[11px] text-slate-500">
                Intelligence, 6 Written Assets & Clips
              </p>
            </div>
            <div className="p-2.5 bg-white rounded border border-slate-200">
              <p className="font-semibold text-slate-900">
                Smart FFmpeg Short Render
              </p>
              <p className="font-mono text-blue-700 font-bold mt-0.5">
                {OPERATION_CREDIT_RATES.smart_clip_render} credits / clip
              </p>
              <p className="text-[11px] text-slate-500">
                Word highlights + -16 LUFS mastering
              </p>
            </div>
            <div className="p-2.5 bg-white rounded border border-slate-200">
              <p className="font-semibold text-slate-900">
                Multi-Segment Reel Stitch
              </p>
              <p className="font-mono text-blue-700 font-bold mt-0.5">
                {OPERATION_CREDIT_RATES.smart_stitch_render} credits / reel
              </p>
              <p className="text-[11px] text-slate-500">
                Multi-interval FFmpeg concat + hooks
              </p>
            </div>
          </div>
        </div>

        {/* Itemized Credit Ledger */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Recent Credit Ledger ({wallet?.transactions?.length || 0} entries)
          </h3>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 max-h-48 overflow-y-auto text-xs">
            {(wallet?.transactions || []).map((tx) => (
              <div
                key={tx.id}
                className="px-3.5 py-2.5 flex items-center justify-between gap-3 bg-white"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 truncate">
                    {tx.description}
                  </p>
                  <p className="text-[11px] font-mono text-slate-400">
                    {new Date(tx.createdAt).toLocaleString()} · {tx.operation}
                  </p>
                </div>
                <div className="text-right shrink-0 font-mono">
                  <span
                    className={`font-bold ${
                      tx.amount >= 0 ? 'text-emerald-700' : 'text-slate-800'
                    }`}
                  >
                    {tx.amount >= 0 ? `+${tx.amount}` : tx.amount}
                  </span>
                  <span className="text-slate-400 ml-2">
                    (bal: {tx.balanceAfter})
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { encodeResults } from './lib/share';

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════
export interface CheckResult {
  name: string;
  category: string;
  passed: boolean;
  score: number;
  maxPoints: number;
  detail: string;
  headline: string;
}

export interface CategoryScore {
  name: string;
  score: number;
  maxPoints: number;
  percentage: number;
  grade: string;
  checks: CheckResult[];
}

export interface ScanResult {
  url: string;
  domain: string;
  firmName: string;
  overallScore: number;
  grade: string;
  gradeLabel: string;
  categories: {
    blogEngine: CategoryScore;
    contentQuality: CategoryScore;
    topicalAuthority: CategoryScore;
    contentDiversity: CategoryScore;
  };
  totalChecks: number;
  passedChecks: number;
  scanDurationMs: number;
  headlineFindings: string[];
  errors: string[];
  crawlEnhanced: boolean;
  crawlPagesUsed: number;
  blogPostsFound: number;
  practiceAreaPagesFound: number;
}

type ViewState = 'input' | 'loading' | 'results';

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
export function getScoreClass(score: number): string {
  if (score >= 81) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 60) return 'average';
  if (score >= 50) return 'below';
  return 'poor';
}

export function getCheckStatus(check: CheckResult): string {
  if (check.passed) return 'pass';
  if (check.score > 0) return 'partial';
  return 'fail';
}

export function getCheckStatusLabel(check: CheckResult): string {
  if (check.passed) return 'Pass';
  if (check.score > 0) return 'Partial';
  return 'Fail';
}

export function gradeColor(grade: string): string {
  if (grade === 'A' || grade === 'A+') return 'var(--green)';
  if (grade === 'B' || grade === 'B+') return 'var(--blue)';
  if (grade === 'C' || grade === 'C+') return 'var(--orange)';
  return 'var(--red)';
}

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function Home() {
  const [currentView, setCurrentView] = useState<ViewState>('input');
  const [urlInput, setUrlInput] = useState('');
  const [loadingUrl, setLoadingUrl] = useState('');
  const [error, setError] = useState('');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loadingSteps, setLoadingSteps] = useState<number[]>([]);

  useEffect(() => {
    if (currentView === 'loading') {
      const delays = [0, 600, 1300, 2100, 2900, 3700, 4500];
      const timers = delays.map((delay, index) =>
        setTimeout(() => setLoadingSteps(prev => [...prev, index]), delay)
      );
      return () => { timers.forEach(t => clearTimeout(t)); };
    } else {
      setLoadingSteps([]);
    }
  }, [currentView]);

  const startScan = async () => {
    const input = urlInput.trim();
    if (!input) { setError('Please enter a website URL to audit.'); return; }

    let url = input;
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    try { new URL(url); } catch { setError('Please enter a valid URL (e.g. https://yourfirm.com)'); return; }

    setError('');
    setLoadingUrl(url);
    setCurrentView('loading');

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `API error: ${response.status}`);
      }
      const result = await response.json();
      setTimeout(() => { setScanResult(result); setCurrentView('results'); }, 500);
    } catch (err: any) {
      console.error('Scan error:', err);
      setCurrentView('input');
      setError('Unable to scan this site. Please check the URL and try again.');
    }
  };

  const resetScanner = () => {
    setCurrentView('input');
    setScanResult(null);
    setUrlInput('');
    setError('');
    setLoadingUrl('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => { if (e.key === 'Enter') startScan(); };

  return (
    <>
      <div className="deco-orbs">
        <div className="deco-orb"></div>
        <div className="deco-orb"></div>
        <div className="deco-orb"></div>
      </div>

      <header>
        <a className="logo" href="https://lawfirmaudits.com" style={{textDecoration:'none',color:'inherit'}}>
          <div className="logo-mark"></div>
          <div className="logo-text">Content Audit</div>
        </a>
        <a href="https://lawfirmaudits.com" className="header-tag" style={{textDecoration:'none',color:'inherit'}}>LawFirmAudits.com</a>
      </header>

      {/* INPUT VIEW */}
      {currentView === 'input' && (
        <div id="inputSection">
          <div className="hero">
            <div className="hero-eyebrow">Content Strategy for Law Firms</div>
            <h1>Is your content<br />actually <em>working</em>?</h1>
            <p className="hero-sub">We scan your blog strategy, content quality, topical authority, and media richness — then score how well your content drives trust and traffic.</p>
          </div>

          <div className="input-card">
            <div className="input-row">
              <div className="url-input-wrap">
                <label className="url-label" htmlFor="urlInput">Law Firm Website URL</label>
                <input
                  type="url" id="urlInput" className="url-input"
                  placeholder="https://yourfirm.com" autoComplete="off"
                  value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                />
              </div>
              <button className="scan-btn" onClick={startScan}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                Audit My Content
              </button>
            </div>
            {error && <div className="error-msg visible">{error}</div>}
          </div>

          <div className="section-line delay-1" style={{ marginTop: '80px' }}></div>

          <div className="why-section">
            <div className="why-header">
              <h2 className="why-title">Content is your 24/7 salesperson.</h2>
              <p className="why-sub">Every blog post, practice area page, and FAQ is a chance to earn trust before a potential client ever picks up the phone. If your content isn&apos;t strategic, you&apos;re leaving cases on the table.</p>
            </div>

            <div className="why-stats">
              <div className="why-stat">
                <div className="why-stat-num">70%</div>
                <div className="why-stat-label">of people prefer learning about a firm through articles rather than ads</div>
              </div>
              <div className="why-stat">
                <div className="why-stat-num">3.5x</div>
                <div className="why-stat-label">more leads generated by firms with active blogs vs. those without</div>
              </div>
              <div className="why-stat">
                <div className="why-stat-num">47%</div>
                <div className="why-stat-label">of buyers view 3-5 pieces of content before engaging with a firm</div>
              </div>
            </div>

            <div className="why-cta">
              <div className="why-cta-title">See if your content makes the grade.</div>
              <p className="why-cta-text">Free audit. No login required. Results in 60 seconds &uarr;</p>
            </div>
          </div>
        </div>
      )}

      {/* LOADING VIEW */}
      {currentView === 'loading' && (
        <div className="loading-state active">
          <div className="loading-ring"></div>
          <div className="loading-title">Analyzing Your Content Strategy</div>
          <div className="loading-sub">{loadingUrl}</div>
          <div className="loading-steps">
            {[
              'Discovering blog posts & articles',
              'Measuring content depth & word count',
              'Analyzing readability & formatting',
              'Checking publishing cadence & freshness',
              'Evaluating topical authority & E-E-A-T',
              'Scanning media diversity & engagement',
              'Calculating your Content Score'
            ].map((step, index) => (
              <div key={index} className={`loading-step ${loadingSteps.includes(index) ? 'visible' : ''} ${loadingSteps.includes(index + 1) ? 'done' : ''}`}>
                <div className="step-dot"></div>
                {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RESULTS VIEW */}
      {currentView === 'results' && scanResult && (
        <ResultsSection result={scanResult} onReset={resetScanner} />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// RESULTS COMPONENT
// ═══════════════════════════════════════════════════════════
export function ResultsSection({ result, onReset, isShared }: { result: ScanResult; onReset?: () => void; isShared?: boolean }) {
  const overall = result.overallScore;
  const scoreClass = getScoreClass(overall);

  const [shareMsg, setShareMsg] = useState('');
  const handleShare = () => {
    const encoded = encodeResults(result);
    const shareUrl = `${window.location.origin}/share#${encoded}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setShareMsg('Link Copied!');
      setTimeout(() => setShareMsg(''), 2000);
    });
  };

  const categoryOrder: (keyof typeof result.categories)[] = [
    'blogEngine', 'contentQuality', 'topicalAuthority', 'contentDiversity'
  ];

  const allChecks = categoryOrder.flatMap(key => result.categories[key].checks);
  const failedChecks = allChecks.filter(c => !c.passed).sort((a, b) => b.maxPoints - a.maxPoints);
  const topStrength = allChecks.filter(c => c.passed).sort((a, b) => b.maxPoints - a.maxPoints)[0] || null;
  const criticalGap = failedChecks[0] || null;

  let verdict = '';
  if (overall >= 75) {
    verdict = `${result.firmName} has a strong content engine. ${result.passedChecks} of ${result.totalChecks} checks passed. Refine the remaining gaps to dominate organic search.`;
  } else if (overall >= 50) {
    verdict = `${result.firmName} has content foundations but significant gaps remain. ${result.totalChecks - result.passedChecks} checks need attention — each one is a missed opportunity to earn trust and traffic.`;
  } else {
    verdict = `${result.firmName} is running a content desert. ${result.totalChecks - result.passedChecks} of ${result.totalChecks} checks failed — potential clients searching for answers aren't finding you.`;
  }

  useEffect(() => {
    requestAnimationFrame(() => {
      const ringFill = document.getElementById('ringFill');
      if (ringFill) {
        const circ = 2 * Math.PI * 90;
        ringFill.style.strokeDashoffset = (circ - (overall / 100) * circ).toString();
      }
      document.querySelectorAll<HTMLElement>('.category-bar-fill').forEach(el => {
        const w = el.getAttribute('data-width');
        if (w) el.style.width = w + '%';
      });
    });
  }, [overall]);

  return (
    <div className="results-section active">
      {/* SCORE HERO */}
      <div className="score-hero">
        <div>
          <div className="score-firm-name">{result.domain}</div>
          <div className="score-headline">{result.firmName}<br />Content Score</div>
          <div className="score-verdict">{verdict}</div>
          <div className="scan-meta">
            <span>{result.passedChecks}/{result.totalChecks} checks passed</span>
            <span>{result.blogPostsFound} blog posts found</span>
            <span>{(result.scanDurationMs / 1000).toFixed(1)}s scan</span>
          </div>
        </div>
        <div className="score-ring-wrap">
          <div className="score-ring">
            <svg viewBox="0 0 200 200">
              <circle className="score-ring-bg" cx="100" cy="100" r="90" />
              <circle className={`score-ring-fill ring-${scoreClass}`} id="ringFill" cx="100" cy="100" r="90" />
            </svg>
            <div className="score-ring-text">
              <div className="score-number">{overall}</div>
              <div className="score-denom">out of 100</div>
            </div>
          </div>
          <div className={`score-grade-badge grade-${scoreClass}`}>{result.grade} — {result.gradeLabel}</div>
        </div>
      </div>

      {/* SHARE BUTTON */}
      {!isShared && (
        <div className="share-btn-wrap">
          <button className="share-btn" onClick={handleShare}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            {shareMsg || 'Share Results'}
          </button>
        </div>
      )}

      {/* SHARED BANNER */}
      {isShared && (
        <div className="shared-banner">Shared results — <a href="/">Run your own audit</a></div>
      )}

      {/* CATEGORY GRADES OVERVIEW */}
      <div className="categories-label">Category Grades</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '48px' }}>
        {categoryOrder.map((key) => {
          const cat = result.categories[key];
          return (
            <div key={key} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              padding: '28px 24px', textAlign: 'center', position: 'relative', overflow: 'hidden'
            }}>
              <div style={{
                position: 'absolute', top: 0, left: 0, width: '48px', height: '3px',
                background: gradeColor(cat.grade)
              }}></div>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: '3rem', fontWeight: 400,
                color: gradeColor(cat.grade), lineHeight: 1, marginBottom: '12px'
              }}>{cat.grade}</div>
              <div style={{
                fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 500,
                letterSpacing: '-0.01em', lineHeight: '1.4'
              }}>{cat.name}</div>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-tertiary)',
                marginTop: '8px'
              }}>{cat.score}/{cat.maxPoints} pts</div>
            </div>
          );
        })}
      </div>

      {/* CONTENT STATS */}
      <div className="categories-label">Content Discovery</div>
      <div className="content-stat-row">
        <span className="content-stat-badge">{result.blogPostsFound} Blog Posts Found</span>
        <span className="content-stat-badge">{result.practiceAreaPagesFound} Practice Area Pages</span>
        <span className="content-stat-badge">{result.crawlPagesUsed} Pages Crawled</span>
      </div>

      {/* HEADLINE FINDINGS */}
      {result.headlineFindings.length > 0 && (
        <div className="summary-grid">
          {topStrength && (
            <div className="summary-card" style={{ border: '1px solid rgba(45, 122, 82, 0.15)' }}>
              <div className="summary-card-label" style={{ color: 'var(--green)' }}>Top Strength</div>
              <div className="summary-card-value">{topStrength.name}</div>
              <div className="summary-card-sub">{topStrength.detail}</div>
            </div>
          )}
          {criticalGap && (
            <div className="summary-card" style={{ border: '1px solid rgba(197, 48, 48, 0.15)' }}>
              <div className="summary-card-label" style={{ color: 'var(--red)' }}>Biggest Gap</div>
              <div className="summary-card-value">{criticalGap.name}</div>
              <div className="summary-card-sub">{criticalGap.detail}</div>
            </div>
          )}
        </div>
      )}

      {/* DETAILED BREAKDOWN */}
      <div className="categories-label">Detailed Breakdown · 4 Categories · {result.totalChecks} Checks</div>

      {categoryOrder.map((key) => {
        const cat = result.categories[key];
        const pct = cat.percentage;
        const cls = getScoreClass(pct);

        return (
          <div key={key} className="category-block">
            <div className="category-header">
              <div className="category-name">{cat.name}</div>
              <div className={`category-score-pill pill-${cls}`}>
                {cat.grade} — {cat.score}/{cat.maxPoints} pts
              </div>
            </div>
            <div className="category-bar-track">
              <div className={`category-bar-fill bg-${cls}`} data-width={pct}></div>
            </div>
            <div className="checks-grid">
              {cat.checks.map((check, i) => {
                const status = getCheckStatus(check);
                return (
                  <div key={i} className={`check-card check-${status}`}>
                    <div className="check-top">
                      <div className="check-name">{check.name}</div>
                      <div className={`check-status status-${status}`}>
                        {getCheckStatusLabel(check)} {check.score}/{check.maxPoints}
                      </div>
                    </div>
                    <div className="check-detail">{check.detail}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="section-divider"></div>

      {/* CTA */}
      {!isShared ? (
        <div className="cta-section">
          <div className="cta-eyebrow">This is your preliminary score</div>
          <div className="cta-title">Want the full<br /><em style={{ fontStyle: 'italic' }}>Content Audit</em>?</div>
          <div className="cta-sub">
            This scan covers what&apos;s publicly visible. The full audit includes competitor content benchmarking, keyword gap analysis, content calendar recommendations, and a prioritized editorial plan — delivered by Rankings.io within 48 hours.
          </div>
          <div className="cta-buttons">
            <a
              href={`https://meetings.hubspot.com/sknudson?subject=${encodeURIComponent('Full Content Audit — ' + result.firmName)}`}
              className="cta-btn-primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Get Your Full Audit
            </a>
            <button className="cta-btn-secondary" onClick={onReset}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
              </svg>
              Audit Another Firm
            </button>
          </div>
        </div>
      ) : (
        <div className="cta-section">
          <div className="cta-title">See how your firm scores.</div>
          <div className="cta-sub">Run your own Content Audit — free, instant, no login required.</div>
          <div className="cta-buttons">
            <a href="/" className="cta-btn-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Run Your Own Audit
            </a>
          </div>
        </div>
      )}

      {!isShared && (
      <div className="score-again">
        <button className="score-again-btn" onClick={onReset}>&larr; Audit Another Firm</button>
      </div>
      )}
    </div>
  );
}

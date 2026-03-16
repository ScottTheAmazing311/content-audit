'use client';

import { useState, useEffect } from 'react';
import { decodeResults } from '../lib/share';
import { ResultsSection, ScanResult } from '../page';

export default function SharePage() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) { setError(true); return; }
    const decoded = decodeResults<ScanResult>(hash);
    if (!decoded) { setError(true); return; }
    setResult(decoded);
  }, []);

  if (error) {
    return (
      <>
        <div className="deco-orbs"><div className="deco-orb"></div><div className="deco-orb"></div><div className="deco-orb"></div></div>
        <header>
          <a className="logo" href="/" style={{textDecoration:'none',color:'inherit'}}>
            <div className="logo-mark"></div>
            <div className="logo-text">Content Audit</div>
          </a>
          <a href="https://lawfirmaudits.com" className="header-tag" style={{textDecoration:'none',color:'inherit'}}>LawFirmAudits.com</a>
        </header>
        <div style={{ textAlign: 'center', padding: '120px 24px' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '16px', color: 'var(--text-primary)' }}>
            Invalid or Expired Link
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '32px', fontSize: '1rem' }}>
            This shared results link is missing or couldn&apos;t be loaded.
          </p>
          <a href="/" style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '1rem', textDecoration: 'none' }}>
            Run Your Own Audit &rarr;
          </a>
        </div>
      </>
    );
  }

  if (!result) return null;

  return (
    <>
      <div className="deco-orbs"><div className="deco-orb"></div><div className="deco-orb"></div><div className="deco-orb"></div></div>
      <header>
        <a className="logo" href="https://lawfirmaudits.com" style={{textDecoration:'none',color:'inherit'}}>
          <div className="logo-mark"></div>
          <div className="logo-text">Content Audit</div>
        </a>
        <a href="https://lawfirmaudits.com" className="header-tag" style={{textDecoration:'none',color:'inherit'}}>LawFirmAudits.com</a>
      </header>
      <ResultsSection result={result} isShared />
    </>
  );
}

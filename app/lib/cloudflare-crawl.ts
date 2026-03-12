/**
 * Cloudflare Browser Rendering /crawl integration for LawFirmAudits.com
 *
 * Drop this file into any audit app's app/lib/ directory.
 * Requires env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_BR_API_TOKEN
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  url: string;
  limit?: number;
  maxDepth?: number;
  formats?: ('markdown' | 'html' | 'json')[];
  excludePatterns?: string[];
  /** Cache duration in seconds (default 86400 = 24h) */
  maxAge?: number;
  /** Reject resource types to speed up crawl */
  rejectResourceTypes?: string[];
}

export interface CrawlPage {
  url: string;
  status: 'completed' | 'queued' | 'disallowed' | 'skipped' | 'errored' | 'cancelled';
  markdown?: string;
  html?: string;
  json?: unknown;
  metadata?: {
    status: number;
    title: string;
    url: string;
  };
}

export interface CrawlResult {
  id: string;
  status: 'completed' | 'running' | 'errored' | 'cancelled_due_to_timeout' | 'cancelled_due_to_limits' | 'cancelled_by_user';
  total: number;
  finished: number;
  pages: CrawlPage[];
  browserSecondsUsed: number;
  errors: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE_PATTERNS = [
  '/privacy-policy*',
  '/terms-*',
  '/wp-admin/*',
  '/wp-login*',
  '/feed/*',
  '/tag/*',
  '/author/*',
  '/cart/*',
  '/checkout/*',
];

const DEFAULT_REJECT_RESOURCES = ['image', 'media', 'font', 'stylesheet'];

const POLL_START_INTERVAL = 5000;   // 5s
const POLL_MAX_INTERVAL = 30000;    // 30s
const POLL_TIMEOUT = 600000;        // 10 min

// ── In-memory cache (persists within a single serverless cold start) ─────────

const crawlCache = new Map<string, { result: CrawlResult; timestamp: number }>();

function getCacheKey(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const domain = u.hostname.replace(/^www\./, '');
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `${domain}:${dateKey}`;
  } catch {
    return `${url}:${Date.now()}`;
  }
}

// ── Core crawl functions ─────────────────────────────────────────────────────

function getApiBase(): string | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`;
}

function getApiToken(): string | null {
  return process.env.CLOUDFLARE_BR_API_TOKEN || null;
}

/**
 * Start a Cloudflare Browser Rendering crawl job.
 * Returns the job ID or null if the API isn't configured.
 */
async function startCrawl(options: CrawlOptions): Promise<string | null> {
  const apiBase = getApiBase();
  const token = getApiToken();
  if (!apiBase || !token) return null;

  const normalizedUrl = options.url.startsWith('http')
    ? options.url
    : `https://${options.url}`;

  const body = {
    url: normalizedUrl,
    limit: options.limit ?? 75,
    depth: options.maxDepth ?? 3,
    formats: options.formats ?? ['markdown', 'html'],
    maxAge: options.maxAge ?? 86400,
    rejectResourceTypes: options.rejectResourceTypes ?? DEFAULT_REJECT_RESOURCES,
    options: {
      excludePatterns: options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
    },
  };

  const res = await fetch(apiBase, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare crawl start failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.result ?? null;
}

/**
 * Poll a crawl job until completion with exponential backoff.
 */
async function pollCrawl(jobId: string): Promise<CrawlResult> {
  const apiBase = getApiBase();
  const token = getApiToken();
  if (!apiBase || !token) {
    throw new Error('Cloudflare API not configured');
  }

  const startTime = Date.now();
  let interval = POLL_START_INTERVAL;
  let allPages: CrawlPage[] = [];

  while (Date.now() - startTime < POLL_TIMEOUT) {
    await new Promise(resolve => setTimeout(resolve, interval));

    let cursor: number | undefined;
    let jobStatus = 'running';
    let total = 0;
    let finished = 0;
    let browserSeconds = 0;

    // Paginate through all results
    do {
      const params = new URLSearchParams();
      if (cursor !== undefined) params.set('cursor', String(cursor));

      const pollUrl = `${apiBase}/${jobId}${params.toString() ? '?' + params.toString() : ''}`;
      const res = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cloudflare crawl poll failed (${res.status}): ${text}`);
      }

      const data = await res.json();
      const result = data.result;
      jobStatus = result.status;
      total = result.total ?? 0;
      finished = result.finished ?? 0;
      browserSeconds = result.browserSecondsUsed ?? 0;

      if (result.records) {
        allPages.push(...result.records);
      }

      cursor = result.cursor ?? undefined;
    } while (cursor !== undefined);

    if (jobStatus && jobStatus !== 'running') {
      return {
        id: jobId,
        status: jobStatus as CrawlResult['status'],
        total,
        finished,
        pages: allPages,
        browserSecondsUsed: browserSeconds,
        errors: jobStatus === 'errored' ? ['Crawl job errored'] : [],
      };
    }

    // Reset pages for next poll cycle (we'll get fresh results)
    allPages = [];

    // Exponential backoff
    interval = Math.min(interval * 1.5, POLL_MAX_INTERVAL);
  }

  throw new Error(`Crawl timed out after ${POLL_TIMEOUT / 1000}s`);
}

/**
 * Main entry point: crawl a website using Cloudflare Browser Rendering.
 * Returns null if the API isn't configured (allows graceful fallback).
 * Uses in-memory cache to avoid re-crawling within the same day.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult | null> {
  // Check cache first
  const cacheKey = getCacheKey(options.url);
  const cached = crawlCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < (options.maxAge ?? 86400) * 1000) {
    return cached.result;
  }

  // Check API configuration
  if (!getApiBase() || !getApiToken()) {
    return null; // Silent fallback — API not configured
  }

  try {
    const jobId = await startCrawl(options);
    if (!jobId) return null;

    const result = await pollCrawl(jobId);

    // Cache the result
    crawlCache.set(cacheKey, { result, timestamp: Date.now() });

    return result;
  } catch (err) {
    console.error('[cloudflare-crawl] Error:', err);
    return null; // Graceful fallback
  }
}

// ── Helper functions for querying crawl data ─────────────────────────────────

/**
 * Get completed pages matching a URL pattern (supports * wildcards).
 */
export function getPagesByPattern(result: CrawlResult, pattern: string): CrawlPage[] {
  const regex = new RegExp(
    '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return result.pages.filter(
    p => p.status === 'completed' && regex.test(new URL(p.url).pathname)
  );
}

/**
 * Find pages whose markdown or HTML contains a keyword (case-insensitive).
 */
export function findPagesContaining(result: CrawlResult, keyword: string): CrawlPage[] {
  const lower = keyword.toLowerCase();
  return result.pages.filter(p => {
    if (p.status !== 'completed') return false;
    const text = (p.markdown || '') + (p.html || '');
    return text.toLowerCase().includes(lower);
  });
}

/**
 * Get the homepage from crawl results.
 */
export function getHomepage(result: CrawlResult): CrawlPage | undefined {
  return result.pages.find(p => {
    if (p.status !== 'completed') return false;
    try {
      const path = new URL(p.url).pathname;
      return path === '/' || path === '';
    } catch {
      return false;
    }
  });
}

/**
 * Get pages by section (practice-areas, attorneys, about, blog, etc.)
 */
export function getPagesBySection(result: CrawlResult, section: string): CrawlPage[] {
  return getPagesByPattern(result, `/${section}*`);
}

/**
 * Count CTA-like elements across the site from HTML content.
 * Looks for buttons, forms, tel: links, chat widget scripts.
 */
export function countCTAs(result: CrawlResult): {
  forms: number;
  phoneLinks: number;
  ctaButtons: number;
  chatWidgets: number;
  pagesWithForms: number;
} {
  let forms = 0, phoneLinks = 0, ctaButtons = 0, chatWidgets = 0, pagesWithForms = 0;

  const chatPatterns = [
    'drift', 'intercom', 'livechat', 'tawk', 'hubspot', 'zendesk',
    'crisp', 'olark', 'freshchat', 'ngage', 'smith.ai', 'ruby',
    'birdeye', 'podium', 'webchat',
  ];

  for (const page of result.pages) {
    if (page.status !== 'completed' || !page.html) continue;
    const html = page.html.toLowerCase();

    const formCount = (html.match(/<form[\s>]/g) || []).length;
    forms += formCount;
    if (formCount > 0) pagesWithForms++;

    phoneLinks += (html.match(/href="tel:/g) || []).length;

    // CTA buttons: links/buttons with action words
    const ctaPattern = /(free consultation|get started|call now|contact us|schedule|book|request|get help|chat with)/gi;
    ctaButtons += (html.match(ctaPattern) || []).length;

    for (const pattern of chatPatterns) {
      if (html.includes(pattern)) {
        chatWidgets++;
        break;
      }
    }
  }

  return { forms, phoneLinks, ctaButtons, chatWidgets, pagesWithForms };
}

/**
 * Extract all JSON-LD structured data from crawl HTML results.
 */
export function extractAllSchema(result: CrawlResult): Array<{ url: string; schemas: unknown[] }> {
  const allSchemas: Array<{ url: string; schemas: unknown[] }> = [];

  for (const page of result.pages) {
    if (page.status !== 'completed' || !page.html) continue;

    const schemas: unknown[] = [];
    const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptPattern.exec(page.html)) !== null) {
      try {
        schemas.push(JSON.parse(match[1]));
      } catch {
        // Invalid JSON-LD, skip
      }
    }

    if (schemas.length > 0) {
      allSchemas.push({ url: page.url, schemas });
    }
  }

  return allSchemas;
}

/**
 * Get content stats across the crawled site.
 */
export function getContentStats(result: CrawlResult): {
  totalPages: number;
  completedPages: number;
  erroredPages: number;
  disallowedPages: number;
  totalWordCount: number;
  avgWordCount: number;
  pagesBySection: Record<string, number>;
} {
  const completedPages = result.pages.filter(p => p.status === 'completed');
  const erroredPages = result.pages.filter(p => p.status === 'errored');
  const disallowedPages = result.pages.filter(p => p.status === 'disallowed');

  let totalWordCount = 0;
  const sectionCounts: Record<string, number> = {};

  for (const page of completedPages) {
    const text = page.markdown || '';
    totalWordCount += text.split(/\s+/).filter(Boolean).length;

    try {
      const pathname = new URL(page.url).pathname;
      const section = pathname.split('/')[1] || 'homepage';
      sectionCounts[section] = (sectionCounts[section] || 0) + 1;
    } catch {
      // skip
    }
  }

  return {
    totalPages: result.pages.length,
    completedPages: completedPages.length,
    erroredPages: erroredPages.length,
    disallowedPages: disallowedPages.length,
    totalWordCount,
    avgWordCount: completedPages.length > 0
      ? Math.round(totalWordCount / completedPages.length)
      : 0,
    pagesBySection: sectionCounts,
  };
}

/**
 * Build a condensed site summary suitable for passing to Claude.
 * Prioritizes key pages and truncates content to fit token budgets.
 */
export function buildSiteSummaryForLLM(
  result: CrawlResult,
  options?: {
    /** Max chars per page markdown (default 3000) */
    maxCharsPerPage?: number;
    /** Max total chars (default 40000) */
    maxTotalChars?: number;
    /** Priority page patterns — these get included first */
    priorityPatterns?: string[];
  }
): string {
  const maxPerPage = options?.maxCharsPerPage ?? 3000;
  const maxTotal = options?.maxTotalChars ?? 40000;
  const priorityPatterns = options?.priorityPatterns ?? [
    '/',
    '/about*',
    '/team*',
    '/attorney*',
    '/lawyer*',
    '/practice-area*',
    '/case-result*',
    '/result*',
    '/testimonial*',
    '/review*',
    '/contact*',
    '/blog*',
  ];

  const completed = result.pages.filter(p => p.status === 'completed' && p.markdown);

  // Sort: priority pages first, then by URL length (shorter = more important)
  const prioritized = completed.sort((a, b) => {
    const aPriority = priorityPatterns.findIndex(pattern => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      try { return regex.test(new URL(a.url).pathname); } catch { return false; }
    });
    const bPriority = priorityPatterns.findIndex(pattern => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      try { return regex.test(new URL(b.url).pathname); } catch { return false; }
    });

    const aScore = aPriority >= 0 ? aPriority : 999;
    const bScore = bPriority >= 0 ? bPriority : 999;
    if (aScore !== bScore) return aScore - bScore;
    return a.url.length - b.url.length;
  });

  let totalChars = 0;
  const parts: string[] = [];

  for (const page of prioritized) {
    if (totalChars >= maxTotal) break;
    const content = (page.markdown || '').slice(0, maxPerPage);
    const title = page.metadata?.title || page.url;
    const section = `## ${title}\nURL: ${page.url}\n\n${content}\n`;

    if (totalChars + section.length > maxTotal) {
      // Include truncated
      const remaining = maxTotal - totalChars;
      if (remaining > 200) {
        parts.push(section.slice(0, remaining) + '\n[truncated]');
      }
      break;
    }

    parts.push(section);
    totalChars += section.length;
  }

  return `# Full Site Crawl (${completed.length} pages crawled)\n\n${parts.join('\n---\n\n')}`;
}

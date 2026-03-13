import * as cheerio from 'cheerio';
import { crawlSite, type CrawlResult } from './cloudflare-crawl';

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

interface FetchedResource {
  content: string | null;
  status: number | null;
  headers: Record<string, string>;
  error: string | null;
  loadTimeMs: number;
}

interface ParsedPage {
  url: string;
  html: string;
  $: cheerio.CheerioAPI;
  title: string;
  metaDescription: string;
  bodyText: string;
  wordCount: number;
  headings: { tag: string; text: string }[];
  internalLinks: { text: string; href: string }[];
  allLinks: { text: string; href: string }[];
  jsonLd: any[];
  hasViewport: boolean;
  htmlSize: number;
  imgCount: number;
  imgWithAlt: number;
  // Content-specific fields
  isBlogPost: boolean;
  isPracticeAreaPage: boolean;
  publishDate: Date | null;
  modifiedDate: Date | null;
  authorName: string | null;
  authorBioLink: string | null;
  hasArticleSchema: boolean;
  hasFAQSchema: boolean;
  paragraphs: string[];
  listCount: number;
  tableCount: number;
  blockquoteCount: number;
  hasStrongEm: boolean;
  videoEmbeds: number;
  pdfLinks: number;
  semanticElements: { article: number; section: number; main: number; aside: number };
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 1_500_000;

// ═══════════════════════════════════════════════════════════
// FETCH HELPERS
// ═══════════════════════════════════════════════════════════
async function fetchResource(url: string, timeoutMs = 10000): Promise<FetchedResource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    const reader = response.body?.getReader();
    if (!reader) return { content: null, status: response.status, headers, error: 'No body', loadTimeMs: Date.now() - start };

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        chunks.push(value.slice(0, MAX_RESPONSE_BYTES - (totalBytes - value.byteLength)));
        reader.cancel();
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    return { content: decoder.decode(Buffer.concat(chunks)), status: response.status, headers, error: null, loadTimeMs: Date.now() - start };
  } catch (err: any) {
    return { content: null, status: null, headers: {}, error: err.message, loadTimeMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════
// READABILITY: FLESCH-KINCAID GRADE LEVEL
// ═══════════════════════════════════════════════════════════
function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function fleschKincaidGrade(text: string): number {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 0);
  if (words.length === 0 || sentences.length === 0) return 0;

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (totalSyllables / words.length) - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

// ═══════════════════════════════════════════════════════════
// PARSE PAGE
// ═══════════════════════════════════════════════════════════
function parsePage(html: string, url: string, baseDomain: string): ParsedPage {
  const $ = cheerio.load(html);
  const htmlSize = html.length;
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';

  const headings: { tag: string; text: string }[] = [];
  $('h1, h2, h3, h4').each((i, el) => {
    if (headings.length >= 50) return false;
    const tag = (el as any).tagName?.toLowerCase() || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text) headings.push({ tag, text });
  });

  // JSON-LD
  const jsonLd: any[] = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const raw = $(el).html();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) jsonLd.push(...parsed);
        else jsonLd.push(parsed);
      }
    } catch { /* skip */ }
  });

  // Links
  const allLinks: { text: string; href: string }[] = [];
  const internalLinks: { text: string; href: string }[] = [];
  $('a[href]').each((i, el) => {
    if (allLinks.length >= 120) return false;
    const href = $(el).attr('href');
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!href || !text) return;
    try {
      const resolved = new URL(href, url).toString();
      allLinks.push({ text, href: resolved });
      const linkHost = new URL(resolved).hostname.replace(/^www\./, '');
      if (linkHost === baseDomain) internalLinks.push({ text, href: resolved });
    } catch { /* skip */ }
  });

  // Body text and word count
  const $body = cheerio.load(html);
  $body('script, style, nav, footer, header, noscript, iframe, svg').remove();
  const bodyText = $body('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // Paragraphs
  const paragraphs: string[] = [];
  $body('p').each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) paragraphs.push(text);
  });

  // Content formatting signals
  const listCount = $('ul, ol').length;
  const tableCount = $('table').length;
  const blockquoteCount = $('blockquote').length;
  const hasStrongEm = $('strong, em, b, i').length > 0;

  // Images
  let imgCount = 0;
  let imgWithAlt = 0;
  $('img').each((_, el) => {
    imgCount++;
    const alt = $(el).attr('alt');
    if (alt && alt.trim().length > 0) imgWithAlt++;
  });

  // Video embeds
  let videoEmbeds = 0;
  videoEmbeds += $('video').length;
  videoEmbeds += $('iframe[src*="youtube"], iframe[src*="youtube-nocookie"], iframe[src*="vimeo"], iframe[src*="wistia"]').length;
  // Also check HTML text for video embed patterns
  if (/youtube\.com\/embed|player\.vimeo\.com|fast\.wistia\.(com|net)/i.test(html)) {
    videoEmbeds = Math.max(videoEmbeds, 1);
  }

  // PDF links
  const pdfLinks = allLinks.filter(l => /\.pdf$/i.test(l.href)).length;

  // Semantic HTML
  const semanticElements = {
    article: $('article').length,
    section: $('section').length,
    main: $('main').length,
    aside: $('aside').length,
  };

  // Viewport
  const hasViewport = !!$('meta[name="viewport"][content*="width"]').attr('content');

  // Blog post detection — match any path containing blog/news/article keywords with a sub-path
  const urlLower = url.toLowerCase();
  const blogIndexPattern = /\/([a-z-]*(?:blog|news|article|insight|post|resource)s?)\/?$/i;
  const blogContainerPattern = /\/([a-z-]*(?:blog|news|article|insight|post|resource)s?)\//i;
  const isBlogPost = blogContainerPattern.test(urlLower) && !blogIndexPattern.test(urlLower);

  // Practice area page detection — broadened to catch state/city prefix patterns
  const isPracticeAreaPage = /\/(practice[_-]?area|service|area-of-practice|specialt)/i.test(urlLower) ||
    /\/(personal[_-]?injury|car[_-]?accident|truck[_-]?accident|wrongful[_-]?death|medical[_-]?malpractice|workers[_-]?comp|slip[_-]?and[_-]?fall|dog[_-]?bite|brain[_-]?injury|birth[_-]?injury|nursing[_-]?home|spinal[_-]?cord|motorcycle|pedestrian|bicycle|construction[_-]?accident|product[_-]?liability|mass[_-]?tort|class[_-]?action|catastrophic)/i.test(urlLower) ||
    // Match state/city prefixed practice area URLs like /utah-car-accident-attorneys/
    /\/[a-z]+-(?:car|truck|motorcycle|bicycle|pedestrian|bus|uber|lyft|rideshare|boat|aviation|drunk[_-]?driving|distracted[_-]?driving|hit[_-]?and[_-]?run|company[_-]?vehicle|government[_-]?vehicle|uninsured)[_-]?(?:accident|crash|collision|injury)[_-]?(?:lawyer|attorney|law)/i.test(urlLower) ||
    /\/[a-z]+-(?:personal[_-]?injury|wrongful[_-]?death|medical[_-]?malpractice|birth[_-]?injury|brain[_-]?injury|spinal[_-]?cord|dog[_-]?bite|slip[_-]?and[_-]?fall|catastrophic[_-]?injury|nursing[_-]?home|premises[_-]?liability|workers[_-]?comp)[_-]?(?:lawyer|attorney|law)/i.test(urlLower);

  // Dates
  let publishDate: Date | null = null;
  let modifiedDate: Date | null = null;

  // From JSON-LD
  for (const item of jsonLd) {
    if (item?.datePublished) try { publishDate = new Date(item.datePublished); } catch {}
    if (item?.dateModified) try { modifiedDate = new Date(item.dateModified); } catch {}
  }

  // From meta tags
  if (!publishDate) {
    const metaDate = $('meta[property="article:published_time"]').attr('content') ||
                     $('meta[name="date"]').attr('content');
    if (metaDate) try { publishDate = new Date(metaDate); } catch {}
  }
  if (!modifiedDate) {
    const metaMod = $('meta[property="article:modified_time"]').attr('content');
    if (metaMod) try { modifiedDate = new Date(metaMod); } catch {}
  }

  // From <time> elements
  if (!publishDate) {
    const timeEl = $('time[datetime]').first().attr('datetime');
    if (timeEl) try { publishDate = new Date(timeEl); } catch {}
  }

  // From visible date text
  if (!publishDate) {
    const dateMatch = bodyText.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+202[3-6]/i);
    if (dateMatch) try { publishDate = new Date(dateMatch[0]); } catch {}
  }

  // Validate dates
  const now = Date.now();
  if (publishDate && (isNaN(publishDate.getTime()) || publishDate.getTime() > now)) publishDate = null;
  if (modifiedDate && (isNaN(modifiedDate.getTime()) || modifiedDate.getTime() > now)) modifiedDate = null;

  // Author
  let authorName: string | null = null;
  let authorBioLink: string | null = null;

  // From JSON-LD
  for (const item of jsonLd) {
    if (item?.author) {
      const author = Array.isArray(item.author) ? item.author[0] : item.author;
      if (typeof author === 'string') authorName = author;
      else if (author?.name) authorName = author.name;
      if (author?.url) authorBioLink = author.url;
    }
  }

  // From meta
  if (!authorName) {
    authorName = $('meta[name="author"]').attr('content')?.trim() || null;
  }

  // From common HTML patterns
  if (!authorName) {
    const authorEl = $('[class*="author"], [rel="author"], .byline, .post-author').first();
    const authorText = authorEl.text().trim().replace(/^by\s+/i, '');
    if (authorText && authorText.length < 60 && !/admin|staff|editor|team/i.test(authorText)) {
      authorName = authorText;
    }
    if (!authorBioLink) {
      const authorLink = authorEl.find('a').attr('href') || authorEl.closest('a').attr('href');
      if (authorLink) try { authorBioLink = new URL(authorLink, url).toString(); } catch {}
    }
  }

  // Schema detection
  const hasArticleSchema = jsonLd.some(item => {
    const type = item?.['@type'];
    return type === 'Article' || type === 'BlogPosting' || type === 'NewsArticle';
  });
  const hasFAQSchema = jsonLd.some(item => {
    const type = item?.['@type'];
    return type === 'FAQPage' || (Array.isArray(type) && type.includes('FAQPage'));
  });

  return {
    url, html, $, title, metaDescription, bodyText, wordCount, headings,
    internalLinks, allLinks, jsonLd, hasViewport, htmlSize, imgCount, imgWithAlt,
    isBlogPost, isPracticeAreaPage, publishDate, modifiedDate,
    authorName, authorBioLink, hasArticleSchema, hasFAQSchema,
    paragraphs, listCount, tableCount, blockquoteCount, hasStrongEm,
    videoEmbeds, pdfLinks, semanticElements,
  };
}

// ═══════════════════════════════════════════════════════════
// SUBPAGE DISCOVERY (blog + content focused)
// ═══════════════════════════════════════════════════════════
function discoverSubpages(homepage: ParsedPage, baseUrl: string, baseDomain: string): string[] {
  const base = new URL(baseUrl);
  const candidates: { url: string; priority: number }[] = [];
  const seen = new Set<string>();
  const keywords = [
    'blog', 'news', 'article', 'insight', 'resource', 'guide',
    'practice', 'service', 'area', 'attorney', 'lawyer', 'about', 'team',
    'faq', 'case-result', 'result', 'testimonial', 'review',
    'personal-injury', 'car-accident', 'truck-accident', 'wrongful-death',
    'medical-malpractice', 'workers-comp', 'podcast', 'video',
    'injury', 'accident', 'liability', 'negligence', 'malpractice',
    'criminal', 'defense', 'family-law', 'divorce', 'custody',
    'estate', 'bankruptcy', 'immigration', 'employment', 'discrimination',
  ];

  for (const link of homepage.allLinks) {
    try {
      const linkUrl = new URL(link.href);
      if (linkUrl.hostname.replace(/^www\./, '') !== baseDomain) continue;
      if (linkUrl.pathname === '/' || linkUrl.pathname === '') continue;
      if (linkUrl.pathname.match(/\.(pdf|jpg|png|gif|svg|css|js|zip)$/i)) continue;

      const normalized = linkUrl.origin + linkUrl.pathname.replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const pathAndText = (linkUrl.pathname + ' ' + link.text).toLowerCase();
      let priority = 0;
      for (const k of keywords) {
        if (pathAndText.includes(k)) priority++;
      }
      // Boost blog posts heavily — match compound blog slugs like /personal-injury-blog/
      if (/\/([a-z-]*(?:blog|news|article|insight|post|resource)s?)\//i.test(linkUrl.pathname)) priority += 5;
      if (priority > 0) candidates.push({ url: normalized, priority });
    } catch { /* skip */ }
  }

  // Fallback paths
  const fallbackPaths = [
    '/blog', '/blog/', '/news', '/articles', '/insights', '/resources',
    '/personal-injury-blog', '/injury-blog', '/legal-blog', '/law-blog',
    '/in-the-news', '/media', '/publications', '/updates',
    '/practice-areas', '/services', '/about', '/about-us',
    '/attorneys', '/team', '/faq', '/results', '/case-results',
  ];
  for (const path of fallbackPaths) {
    const fallbackUrl = base.origin + path;
    if (!seen.has(fallbackUrl)) {
      candidates.push({ url: fallbackUrl, priority: 1 });
      seen.add(fallbackUrl);
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, 15).map(c => c.url);
}

// ═══════════════════════════════════════════════════════════
// BLOG POST DISCOVERY FROM INDEX PAGES
// ═══════════════════════════════════════════════════════════
function discoverBlogPosts(blogIndexPages: ParsedPage[], baseDomain: string): string[] {
  const posts: string[] = [];
  const seen = new Set<string>();

  for (const page of blogIndexPages) {
    for (const link of page.allLinks) {
      try {
        const linkUrl = new URL(link.href);
        if (linkUrl.hostname.replace(/^www\./, '') !== baseDomain) continue;
        const path = linkUrl.pathname.toLowerCase();
        // Is it a blog post (under a blog-like section but not the index itself)?
        if (/\/([a-z-]*(?:blog|news|article|insight|post|resource)s?)\/.+/i.test(path)) {
          const normalized = linkUrl.origin + linkUrl.pathname.replace(/\/$/, '');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            posts.push(normalized);
          }
        }
      } catch {}
    }
  }

  return posts;
}

// ═══════════════════════════════════════════════════════════
// GRADE HELPERS
// ═══════════════════════════════════════════════════════════
function gradeFromScore(score: number): { grade: string; label: string } {
  if (score >= 85) return { grade: 'A+', label: 'Content Powerhouse' };
  if (score >= 75) return { grade: 'A', label: 'Strong Content Engine' };
  if (score >= 65) return { grade: 'B+', label: 'Above Average' };
  if (score >= 55) return { grade: 'B', label: 'Developing Strategy' };
  if (score >= 45) return { grade: 'C+', label: 'Needs Work' };
  if (score >= 35) return { grade: 'C', label: 'Content Gaps' };
  return { grade: 'D', label: 'Content Desert' };
}

function categoryGrade(pct: number): string {
  if (pct >= 80) return 'A';
  if (pct >= 65) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 35) return 'D';
  return 'F';
}

function extractFirmName(page: ParsedPage): string {
  for (const item of page.jsonLd) {
    if (item?.name && typeof item.name === 'string') return item.name;
  }
  if (page.title) {
    return page.title
      .replace(/\s*[-|–—]\s*(home|welcome|attorney|lawyer|law\s*firm|personal\s*injury).*/i, '')
      .replace(/\s*[-|–—]\s*.*$/i, '')
      .trim() || page.title;
  }
  return new URL(page.url).hostname;
}

// ═══════════════════════════════════════════════════════════
// CATEGORY A: BLOG & PUBLISHING ENGINE (25 pts)
// ═══════════════════════════════════════════════════════════

function checkBlogExists(pages: ParsedPage[], blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 5;
  const hasBlogSection = pages.some(p =>
    /\/(blog|news|article|insight|resource)s?\/?$/i.test(p.url)
  );

  if (blogPosts.length >= 5 && hasBlogSection) {
    return {
      name: 'Blog / Content Hub', category: 'blogEngine', passed: true,
      score: maxPoints, maxPoints,
      detail: `Active blog found with ${blogPosts.length} posts detected. A content hub is essential for organic traffic growth.`,
      headline: `Blog active with ${blogPosts.length} posts`
    };
  }
  if (blogPosts.length > 0 || hasBlogSection) {
    return {
      name: 'Blog / Content Hub', category: 'blogEngine', passed: false,
      score: 2, maxPoints,
      detail: `Blog section ${hasBlogSection ? 'found' : 'not clearly defined'} with ${blogPosts.length} post(s) detected. Most top-ranking firms publish 50+ articles.`,
      headline: `${blogPosts.length} blog post(s) found`
    };
  }
  return {
    name: 'Blog / Content Hub', category: 'blogEngine', passed: false,
    score: 0, maxPoints,
    detail: 'No blog or content section found. Firms without a blog miss 434% more indexed pages and 97% more inbound links on average.',
    headline: 'No blog found'
  };
}

function checkPostVolume(blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 6;
  const count = blogPosts.length;

  let score = 0;
  if (count >= 50) score = 6;
  else if (count >= 25) score = 5;
  else if (count >= 10) score = 3;
  else if (count >= 5) score = 2;
  else if (count >= 1) score = 1;

  const passed = score >= 5;
  return {
    name: 'Content Volume', category: 'blogEngine', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${count} blog posts found. Strong content library that builds topical authority over time.`
      : `Only ${count} blog post(s) found. Top-performing law firm blogs have 50-100+ articles. Each post is a new entry point from search.`,
    headline: passed ? `${count} posts — strong library` : `Only ${count} blog post(s)`
  };
}

function checkPublishingRecency(blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 7;
  const now = Date.now();

  const dates = blogPosts
    .map(p => p.publishDate || p.modifiedDate)
    .filter(Boolean)
    .map(d => d!.getTime())
    .filter(t => t < now && t > now - 5 * 365 * 24 * 60 * 60 * 1000)
    .sort((a, b) => b - a);

  if (dates.length === 0) {
    // Check all pages for any date signals
    return {
      name: 'Publishing Recency', category: 'blogEngine', passed: false,
      score: 0, maxPoints,
      detail: 'No publication dates detected on any content. Without dated content, Google can\'t assess freshness — a key ranking signal.',
      headline: 'No content dates found'
    };
  }

  const mostRecent = dates[0];
  const daysSince = Math.round((now - mostRecent) / (24 * 60 * 60 * 1000));

  let score = 0;
  if (daysSince <= 30) score = 7;
  else if (daysSince <= 90) score = 5;
  else if (daysSince <= 180) score = 3;
  else if (daysSince <= 365) score = 1;

  const passed = score >= 5;
  return {
    name: 'Publishing Recency', category: 'blogEngine', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Most recent content published ${daysSince} days ago. Active publishing signals authority and freshness to Google.`
      : `Most recent content is ${daysSince} days old.${daysSince > 180 ? ' Your blog appears abandoned — Google deprioritizes stale sites.' : ' Aim for at least 2-4 posts per month for steady organic growth.'}`,
    headline: passed ? `Published ${daysSince}d ago` : `Content ${daysSince}d stale`
  };
}

function checkPublishingCadence(blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 7;
  const now = Date.now();

  const dates = blogPosts
    .map(p => p.publishDate || p.modifiedDate)
    .filter(Boolean)
    .map(d => d!.getTime())
    .filter(t => t < now && t > now - 2 * 365 * 24 * 60 * 60 * 1000) // last 2 years
    .sort((a, b) => a - b);

  if (dates.length < 3) {
    return {
      name: 'Publishing Cadence', category: 'blogEngine', passed: false,
      score: dates.length > 0 ? 1 : 0, maxPoints,
      detail: `Only ${dates.length} datable post(s) found in the last 2 years. Consistent publishing (2-4x/month) is what builds organic momentum.`,
      headline: `${dates.length} dated post(s) in 2yr`
    };
  }

  // Calculate posts per month over last 12 months
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const recentDates = dates.filter(d => d > oneYearAgo);
  const postsPerMonth = recentDates.length / 12;

  // Check consistency: calculate gaps between posts
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (24 * 60 * 60 * 1000)); // days between posts
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const maxGap = Math.max(...gaps);

  let score = 0;
  if (postsPerMonth >= 4) score = 7;
  else if (postsPerMonth >= 2) score = 5;
  else if (postsPerMonth >= 1) score = 3;
  else if (postsPerMonth >= 0.5) score = 2;
  else score = 1;

  // Penalize for long gaps (inconsistency)
  if (maxGap > 120 && score > 2) score -= 1;

  const passed = score >= 5;
  return {
    name: 'Publishing Cadence', category: 'blogEngine', passed,
    score: Math.min(Math.max(score, 0), maxPoints), maxPoints,
    detail: passed
      ? `Publishing at ~${postsPerMonth.toFixed(1)} posts/month. Consistent cadence builds compounding organic traffic.`
      : `Publishing at ~${postsPerMonth.toFixed(1)} posts/month.${maxGap > 120 ? ` Longest gap: ${Math.round(maxGap)} days — inconsistency hurts rankings.` : ''} Target 2-4 posts/month for competitive markets.`,
    headline: passed ? `${postsPerMonth.toFixed(1)} posts/mo` : `Only ${postsPerMonth.toFixed(1)} posts/mo`
  };
}

// ═══════════════════════════════════════════════════════════
// CATEGORY B: CONTENT QUALITY & READABILITY (30 pts)
// ═══════════════════════════════════════════════════════════

function checkContentDepth(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 8;
  const contentPages = [...blogPosts, ...practicePages];

  if (contentPages.length === 0) {
    return {
      name: 'Content Depth', category: 'contentQuality', passed: false,
      score: 0, maxPoints,
      detail: 'No content pages found to evaluate depth. Create in-depth practice area pages and blog posts with 1000+ words.',
      headline: 'No content to measure'
    };
  }

  const wordCounts = contentPages.map(p => p.wordCount);
  const avgWords = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  const deepPages = wordCounts.filter(w => w >= 1000).length;
  const thinPages = wordCounts.filter(w => w < 300).length;

  let score = 0;
  if (avgWords >= 1500) score = 8;
  else if (avgWords >= 1000) score = 6;
  else if (avgWords >= 600) score = 4;
  else if (avgWords >= 300) score = 2;

  // Penalize if many thin pages
  if (thinPages > contentPages.length / 2 && score > 2) score -= 1;

  const passed = score >= 6;
  return {
    name: 'Content Depth', category: 'contentQuality', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Content averages ${Math.round(avgWords)} words. ${deepPages} page(s) exceed 1000 words. Comprehensive content ranks higher and builds trust.`
      : `Content averages only ${Math.round(avgWords)} words.${thinPages > 0 ? ` ${thinPages} page(s) have fewer than 300 words (thin content).` : ''} Google rewards thorough, helpful content — aim for 1000-2000 words on key pages.`,
    headline: passed ? `${Math.round(avgWords)} avg words` : `Only ${Math.round(avgWords)} avg words`
  };
}

function checkReadability(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 6;
  const contentPages = [...blogPosts, ...practicePages].filter(p => p.wordCount >= 200);

  if (contentPages.length === 0) {
    return {
      name: 'Readability Level', category: 'contentQuality', passed: false,
      score: 0, maxPoints,
      detail: 'Not enough content to assess readability. Legal content for consumers should target an 8th-10th grade reading level.',
      headline: 'No content to assess'
    };
  }

  const grades = contentPages.map(p => fleschKincaidGrade(p.bodyText));
  const avgGrade = grades.reduce((a, b) => a + b, 0) / grades.length;

  let score = 0;
  // Ideal range: 7-10 grade level for consumer-facing legal content
  if (avgGrade >= 7 && avgGrade <= 10) score = 6;
  else if (avgGrade >= 6 && avgGrade <= 11) score = 5;
  else if (avgGrade >= 5 && avgGrade <= 12) score = 3;
  else if (avgGrade <= 14) score = 2;
  else score = 1;

  const passed = score >= 5;
  return {
    name: 'Readability Level', category: 'contentQuality', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Readability: grade ${avgGrade.toFixed(1)} (Flesch-Kincaid). Well-suited for potential clients who need clear, accessible explanations.`
      : `Readability: grade ${avgGrade.toFixed(1)} (Flesch-Kincaid).${avgGrade > 12 ? ' Content is too complex for most readers. Simplify language — potential clients aren\'t lawyers.' : avgGrade < 6 ? ' Content may be too simplistic. Aim for grade 8-10 to balance accessibility with authority.' : ' Aim for grade 8-10 for optimal client comprehension.'}`,
    headline: passed ? `Grade ${avgGrade.toFixed(1)} readability` : `Grade ${avgGrade.toFixed(1)} — ${avgGrade > 12 ? 'too complex' : 'needs tuning'}`
  };
}

function checkContentFormatting(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 5;
  const contentPages = [...blogPosts, ...practicePages].filter(p => p.wordCount >= 200);

  if (contentPages.length === 0) {
    return {
      name: 'Content Formatting', category: 'contentQuality', passed: false,
      score: 0, maxPoints,
      detail: 'No content pages to evaluate formatting. Well-formatted content uses lists, subheadings, and visual breaks.',
      headline: 'No content to assess'
    };
  }

  let wellFormattedCount = 0;
  for (const page of contentPages) {
    const headingsPerK = (page.headings.length / (page.wordCount / 1000));
    const hasLists = page.listCount > 0;
    const hasEmphasis = page.hasStrongEm;
    const formatSignals = [headingsPerK >= 2, hasLists, hasEmphasis, page.blockquoteCount > 0, page.tableCount > 0];
    const signalCount = formatSignals.filter(Boolean).length;
    if (signalCount >= 2) wellFormattedCount++;
  }

  const pctFormatted = (wellFormattedCount / contentPages.length) * 100;

  let score = 0;
  if (pctFormatted >= 80) score = 5;
  else if (pctFormatted >= 60) score = 4;
  else if (pctFormatted >= 40) score = 3;
  else if (pctFormatted >= 20) score = 1;

  const passed = score >= 4;
  return {
    name: 'Content Formatting', category: 'contentQuality', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${Math.round(pctFormatted)}% of content pages are well-formatted (subheadings, lists, emphasis). Scannable content keeps readers engaged.`
      : `Only ${Math.round(pctFormatted)}% of content is well-formatted. Use subheadings every 200-300 words, bullet lists, and bold text to break up walls of text.`,
    headline: passed ? `${Math.round(pctFormatted)}% well-formatted` : `Only ${Math.round(pctFormatted)}% formatted`
  };
}

function checkThinContent(allPages: ParsedPage[]): CheckResult {
  const maxPoints = 5;
  const contentPages = allPages.filter(p =>
    !/(contact|privacy|terms|sitemap|404|login|admin)/i.test(p.url)
  );

  if (contentPages.length === 0) {
    return {
      name: 'Thin Content Detection', category: 'contentQuality', passed: false,
      score: 0, maxPoints,
      detail: 'No pages found to evaluate.',
      headline: 'No pages found'
    };
  }

  const thinPages = contentPages.filter(p => p.wordCount < 300);
  const thinPct = (thinPages.length / contentPages.length) * 100;

  let score = 0;
  if (thinPct <= 10) score = 5;
  else if (thinPct <= 25) score = 4;
  else if (thinPct <= 40) score = 2;
  else if (thinPct <= 60) score = 1;

  const passed = score >= 4;
  return {
    name: 'Thin Content Detection', category: 'contentQuality', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Only ${thinPages.length} of ${contentPages.length} pages have thin content (<300 words). Your content has substance.`
      : `${thinPages.length} of ${contentPages.length} pages (${Math.round(thinPct)}%) have thin content (<300 words). Google's Helpful Content system demotes sites with too many low-value pages.`,
    headline: passed ? `${Math.round(100 - thinPct)}% pages substantive` : `${Math.round(thinPct)}% pages are thin`
  };
}

function checkParagraphStructure(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 6;
  const contentPages = [...blogPosts, ...practicePages].filter(p => p.paragraphs.length >= 3);

  if (contentPages.length === 0) {
    return {
      name: 'Paragraph Structure', category: 'contentQuality', passed: false,
      score: 0, maxPoints,
      detail: 'Not enough content to evaluate paragraph structure. Use short paragraphs (2-4 sentences) for web readability.',
      headline: 'No content to assess'
    };
  }

  // Calculate average paragraph word count
  const allParaLengths = contentPages.flatMap(p =>
    p.paragraphs.map(para => para.split(/\s+/).length)
  );
  const avgParaWords = allParaLengths.reduce((a, b) => a + b, 0) / allParaLengths.length;
  const longParas = allParaLengths.filter(w => w > 150).length;
  const longParaPct = (longParas / allParaLengths.length) * 100;

  let score = 0;
  if (avgParaWords <= 80 && longParaPct <= 10) score = 6;
  else if (avgParaWords <= 100 && longParaPct <= 20) score = 5;
  else if (avgParaWords <= 120) score = 3;
  else if (avgParaWords <= 150) score = 2;
  else score = 1;

  const passed = score >= 4;
  return {
    name: 'Paragraph Structure', category: 'contentQuality', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Avg paragraph length: ${Math.round(avgParaWords)} words. Short, scannable paragraphs keep readers engaged on mobile and desktop.`
      : `Avg paragraph length: ${Math.round(avgParaWords)} words.${longParaPct > 20 ? ` ${Math.round(longParaPct)}% of paragraphs exceed 150 words — walls of text drive readers away.` : ''} Aim for 2-4 sentences (50-80 words) per paragraph.`,
    headline: passed ? `${Math.round(avgParaWords)}w avg paragraphs` : `${Math.round(avgParaWords)}w avg — too long`
  };
}

// ═══════════════════════════════════════════════════════════
// CATEGORY C: TOPICAL AUTHORITY & E-E-A-T (25 pts)
// ═══════════════════════════════════════════════════════════

function checkTopicClusters(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 7;

  if (practicePages.length === 0) {
    return {
      name: 'Topic Clusters', category: 'topicalAuthority', passed: false,
      score: blogPosts.length > 5 ? 1 : 0, maxPoints,
      detail: 'No practice area pillar pages found. Topic clusters (pillar page + supporting blog posts) are how Google determines topical authority.',
      headline: 'No pillar pages found'
    };
  }

  // For each practice area page, count blog posts that link TO it
  let clusteredPAs = 0;
  let totalSupportingPosts = 0;

  for (const pa of practicePages) {
    const paPath = new URL(pa.url).pathname;
    const supportingPosts = blogPosts.filter(post =>
      post.internalLinks.some(l => {
        try { return new URL(l.href).pathname === paPath; } catch { return false; }
      })
    );
    if (supportingPosts.length >= 2) {
      clusteredPAs++;
      totalSupportingPosts += supportingPosts.length;
    }
  }

  let score = 0;
  if (clusteredPAs >= 3) score = 7;
  else if (clusteredPAs >= 2) score = 5;
  else if (clusteredPAs >= 1) score = 3;
  else if (blogPosts.length > 0 && practicePages.length > 0) score = 1;

  const passed = score >= 5;
  return {
    name: 'Topic Clusters', category: 'topicalAuthority', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${clusteredPAs} practice area(s) have content clusters (pillar page + ${totalSupportingPosts} supporting posts). This is how top firms build topical authority.`
      : `Only ${clusteredPAs} practice area(s) have supporting blog content linking to them. Create 3-5 blog posts per practice area that link back to the main service page.`,
    headline: passed ? `${clusteredPAs} topic clusters` : `${clusteredPAs} topic cluster(s)`
  };
}

function checkAuthorAttribution(blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 5;

  if (blogPosts.length === 0) {
    return {
      name: 'Author Attribution', category: 'topicalAuthority', passed: false,
      score: 0, maxPoints,
      detail: 'No blog posts to check for author attribution. Google\'s E-E-A-T guidelines reward content with clear, credentialed authorship.',
      headline: 'No posts to check'
    };
  }

  const withAuthor = blogPosts.filter(p => p.authorName && !/admin|staff|editor|team/i.test(p.authorName));
  const pct = (withAuthor.length / blogPosts.length) * 100;

  let score = 0;
  if (pct >= 90) score = 5;
  else if (pct >= 60) score = 4;
  else if (pct >= 30) score = 2;
  else if (pct > 0) score = 1;

  const passed = score >= 4;
  const authorNames = [...new Set(withAuthor.map(p => p.authorName))].slice(0, 3);
  return {
    name: 'Author Attribution', category: 'topicalAuthority', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${Math.round(pct)}% of posts have named authors${authorNames.length > 0 ? ` (${authorNames.join(', ')})` : ''}. Author attribution is a core E-E-A-T signal.`
      : `Only ${Math.round(pct)}% of posts have named authors. Google's E-E-A-T guidelines strongly favor content attributed to real, credentialed professionals — not "Admin" or "Staff."`,
    headline: passed ? `${Math.round(pct)}% posts have authors` : `Only ${Math.round(pct)}% have authors`
  };
}

function checkAuthorCredentials(pages: ParsedPage[]): CheckResult {
  const maxPoints = 5;
  const allText = pages.map(p => p.bodyText + ' ' + p.html).join(' ');
  const allJsonLd = pages.flatMap(p => p.jsonLd);

  // Person schema
  const hasPersonSchema = allJsonLd.some(item => {
    const type = item?.['@type'];
    return type === 'Person' || type === 'Attorney';
  });

  // Credential signals
  const signals: string[] = [];
  if (/\bj\.?d\.?\b|juris\s*doctor/i.test(allText)) signals.push('J.D.');
  if (/\besq\.?\b|esquire/i.test(allText)) signals.push('Esq.');
  if (/board\s*certified/i.test(allText)) signals.push('Board Certified');
  if (/super\s*lawyer/i.test(allText)) signals.push('Super Lawyers');
  if (/bar\s*admiss|admitted\s*to\s*(?:the\s*)?bar/i.test(allText)) signals.push('Bar Admission');
  if (/\d+\s*\+?\s*years?\s*(?:of\s*)?experience/i.test(allText)) signals.push('Years of Experience');
  if (/million\s*dollar\s*advocate|best\s*lawyer/i.test(allText)) signals.push('Awards');

  // Author bio pages
  const bioPages = pages.filter(p => /\/(attorney|lawyer|team|about|people|staff|bio)/i.test(p.url));
  const hasBioPages = bioPages.length > 0;

  let score = 0;
  if (hasPersonSchema && signals.length >= 3 && hasBioPages) score = 5;
  else if (signals.length >= 3 && hasBioPages) score = 4;
  else if (signals.length >= 2 || hasBioPages) score = 3;
  else if (signals.length >= 1) score = 1;

  const passed = score >= 4;
  return {
    name: 'Author Credentials (E-E-A-T)', category: 'topicalAuthority', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Strong E-E-A-T signals: ${signals.slice(0, 4).join(', ')}.${hasPersonSchema ? ' Person schema found.' : ''}${hasBioPages ? ` ${bioPages.length} bio page(s).` : ''} Google uses these to assess content trustworthiness.`
      : `${signals.length > 0 ? `Found: ${signals.join(', ')}.` : 'No credential signals found.'} ${!hasBioPages ? 'No attorney bio pages.' : ''} ${!hasPersonSchema ? 'No Person schema.' : ''} E-E-A-T (Experience, Expertise, Authority, Trust) is Google's top content quality framework.`,
    headline: passed ? `${signals.length} E-E-A-T signals` : `Weak E-E-A-T signals`
  };
}

function checkArticleSchema(blogPosts: ParsedPage[]): CheckResult {
  const maxPoints = 4;

  if (blogPosts.length === 0) {
    return {
      name: 'Article Schema Markup', category: 'topicalAuthority', passed: false,
      score: 0, maxPoints,
      detail: 'No blog posts to check for Article schema. BlogPosting/Article JSON-LD helps Google understand and feature your content.',
      headline: 'No posts to check'
    };
  }

  const withSchema = blogPosts.filter(p => p.hasArticleSchema);
  const pct = (withSchema.length / blogPosts.length) * 100;

  // Check for completeness (author, datePublished, image in schema)
  let completeSchema = 0;
  for (const post of withSchema) {
    const article = post.jsonLd.find(item =>
      ['Article', 'BlogPosting', 'NewsArticle'].includes(item?.['@type'])
    );
    if (article?.author && article?.datePublished && article?.image) completeSchema++;
  }

  let score = 0;
  if (pct >= 80 && completeSchema >= withSchema.length * 0.5) score = 4;
  else if (pct >= 50) score = 3;
  else if (pct > 0) score = 1;

  const passed = score >= 3;
  return {
    name: 'Article Schema Markup', category: 'topicalAuthority', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${Math.round(pct)}% of posts have Article/BlogPosting schema. ${completeSchema} with complete author+date+image. Eligible for rich results.`
      : `${Math.round(pct)}% of posts have Article schema.${withSchema.length > 0 && completeSchema < withSchema.length ? ' Many are missing author, date, or image fields.' : ''} Proper schema makes posts eligible for Google rich snippets.`,
    headline: passed ? `${Math.round(pct)}% have Article schema` : `${Math.round(pct)}% have schema`
  };
}

function checkContentCoverageGaps(blogPosts: ParsedPage[], practicePages: ParsedPage[], allPages: ParsedPage[]): CheckResult {
  const maxPoints = 4;

  // Check if practice areas mentioned in nav have supporting content
  const allText = allPages.map(p => p.bodyText).join(' ').toLowerCase();
  const allUrls = allPages.map(p => p.url.toLowerCase()).join(' ');

  const topicsCovered: string[] = [];
  const topicsMap = [
    { topic: 'FAQ', pattern: /faq|frequently\s*asked/i },
    { topic: 'Case Results', pattern: /case[_\s-]?result|verdict|settlement/i },
    { topic: 'Client Stories', pattern: /testimonial|client\s*(?:story|review|said)/i },
    { topic: 'Legal Guides', pattern: /guide|how[_\s-]?to|step[_\s-]?by[_\s-]?step|checklist/i },
    { topic: 'News/Updates', pattern: /news|update|announcement|press/i },
    { topic: 'Community/Local', pattern: /community|local|event|sponsorship/i },
  ];

  for (const t of topicsMap) {
    if (t.pattern.test(allText) || t.pattern.test(allUrls)) topicsCovered.push(t.topic);
  }

  let score = 0;
  if (topicsCovered.length >= 5) score = 4;
  else if (topicsCovered.length >= 3) score = 3;
  else if (topicsCovered.length >= 2) score = 2;
  else if (topicsCovered.length >= 1) score = 1;

  const passed = score >= 3;
  const missing = topicsMap.filter(t => !topicsCovered.includes(t.topic)).map(t => t.topic);

  return {
    name: 'Content Type Coverage', category: 'topicalAuthority', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${topicsCovered.length} content types found: ${topicsCovered.join(', ')}. Diverse content signals comprehensive expertise.`
      : `Only ${topicsCovered.length} content type(s) found: ${topicsCovered.join(', ') || 'none'}.${missing.length > 0 ? ` Missing: ${missing.slice(0, 3).join(', ')}.` : ''} Diversify beyond blog posts to build authority.`,
    headline: passed ? `${topicsCovered.length} content types` : `Only ${topicsCovered.length} content type(s)`
  };
}

// ═══════════════════════════════════════════════════════════
// CATEGORY D: CONTENT DIVERSITY & ENGAGEMENT (20 pts)
// ═══════════════════════════════════════════════════════════

function checkVideoContent(allPages: ParsedPage[]): CheckResult {
  const maxPoints = 5;
  const totalVideos = allPages.reduce((sum, p) => sum + p.videoEmbeds, 0);
  const pagesWithVideo = allPages.filter(p => p.videoEmbeds > 0).length;

  // Also check for podcast signals
  const allHtml = allPages.map(p => p.html).join(' ');
  const hasPodcast = /spotify\.com\/embed|podcasters\.spotify|anchor\.fm|buzzsprout|podbean|libsyn|apple.*podcast|soundcloud\.com\/player/i.test(allHtml);

  let score = 0;
  if (totalVideos >= 10 || (totalVideos >= 5 && hasPodcast)) score = 5;
  else if (totalVideos >= 5) score = 4;
  else if (totalVideos >= 2) score = 3;
  else if (totalVideos >= 1 || hasPodcast) score = 2;

  const passed = score >= 4;
  return {
    name: 'Video & Media Content', category: 'contentDiversity', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${totalVideos} video embed(s) across ${pagesWithVideo} page(s).${hasPodcast ? ' Podcast detected.' : ''} Video content drives 157% more organic traffic and builds personal connection.`
      : `${totalVideos} video embed(s) found.${hasPodcast ? ' Podcast detected.' : ''} Video on practice area pages and attorney bios can increase time-on-page by 88% and dramatically improve trust.`,
    headline: passed ? `${totalVideos} videos${hasPodcast ? ' + podcast' : ''}` : `${totalVideos} video(s) found`
  };
}

function checkVisualRichness(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 4;
  const contentPages = [...blogPosts, ...practicePages].filter(p => p.wordCount >= 300);

  if (contentPages.length === 0) {
    return {
      name: 'Visual Content Richness', category: 'contentDiversity', passed: false,
      score: 0, maxPoints,
      detail: 'No content pages to evaluate for visual richness.',
      headline: 'No content to assess'
    };
  }

  // Check images per 1000 words
  let wellIllustratedCount = 0;
  for (const page of contentPages) {
    const imgsPerK = (page.imgCount / (page.wordCount / 1000));
    if (imgsPerK >= 1) wellIllustratedCount++;
  }

  const pct = (wellIllustratedCount / contentPages.length) * 100;

  // Check for <figure> and <figcaption> usage (proper image annotation)
  const hasFigures = contentPages.some(p => p.$('figure').length > 0);

  let score = 0;
  if (pct >= 60 && hasFigures) score = 4;
  else if (pct >= 60) score = 3;
  else if (pct >= 30) score = 2;
  else if (pct > 0) score = 1;

  const passed = score >= 3;
  return {
    name: 'Visual Content Richness', category: 'contentDiversity', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${Math.round(pct)}% of content pages are well-illustrated (1+ images per 1000 words).${hasFigures ? ' Proper <figure>/<figcaption> markup detected.' : ''}`
      : `Only ${Math.round(pct)}% of content pages have adequate images. Add relevant visuals (infographics, diagrams, photos) — articles with images get 94% more views.`,
    headline: passed ? `${Math.round(pct)}% well-illustrated` : `Only ${Math.round(pct)}% have images`
  };
}

function checkDownloadableResources(allPages: ParsedPage[]): CheckResult {
  const maxPoints = 4;
  const totalPDFs = allPages.reduce((sum, p) => sum + p.pdfLinks, 0);

  // Check for gated content / lead magnets
  const allText = allPages.map(p => p.bodyText + ' ' + p.html).join(' ');
  const hasLeadMagnet = /download\s*(?:our|the|free|this)\s*(?:guide|ebook|checklist|whitepaper|report)/i.test(allText);
  const hasGatedContent = /(?:enter\s*your\s*email|get\s*(?:instant|free)\s*access|download\s*now)/i.test(allText);

  let score = 0;
  if ((totalPDFs >= 3 || hasLeadMagnet) && hasGatedContent) score = 4;
  else if (totalPDFs >= 3 || hasLeadMagnet) score = 3;
  else if (totalPDFs >= 1 || hasGatedContent) score = 2;

  const passed = score >= 3;
  return {
    name: 'Downloadable Resources', category: 'contentDiversity', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${totalPDFs} downloadable resource(s) found.${hasLeadMagnet ? ' Lead magnet / guide content detected.' : ''}${hasGatedContent ? ' Gated content for lead capture.' : ''} Resources build authority and capture emails.`
      : `${totalPDFs} downloadable resource(s) found. Create free guides, checklists, or ebooks — they position your firm as an authority and capture leads.`,
    headline: passed ? `${totalPDFs} resources${hasLeadMagnet ? ' + lead magnets' : ''}` : `${totalPDFs} downloadable(s)`
  };
}

function checkSemanticHTML(allPages: ParsedPage[]): CheckResult {
  const maxPoints = 3;
  const contentPages = allPages.filter(p => p.wordCount >= 200);

  if (contentPages.length === 0) {
    return {
      name: 'Semantic HTML Structure', category: 'contentDiversity', passed: false,
      score: 0, maxPoints,
      detail: 'No pages to evaluate for semantic HTML. Using <article>, <section>, <main> helps search engines and AI understand your content structure.',
      headline: 'No pages to assess'
    };
  }

  const withSemanticHtml = contentPages.filter(p => {
    const s = p.semanticElements;
    return (s.article > 0 || s.main > 0) && s.section > 0;
  });
  const pct = (withSemanticHtml.length / contentPages.length) * 100;

  let score = 0;
  if (pct >= 60) score = 3;
  else if (pct >= 30) score = 2;
  else if (pct > 0) score = 1;

  const passed = score >= 2;
  return {
    name: 'Semantic HTML Structure', category: 'contentDiversity', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `${Math.round(pct)}% of pages use semantic HTML (<article>, <section>, <main>). This helps Google and AI systems understand your content structure.`
      : `Only ${Math.round(pct)}% of pages use semantic HTML. Replace generic <div> layouts with <article>, <section>, <main> — it improves both SEO and AI readability.`,
    headline: passed ? `${Math.round(pct)}% semantic HTML` : `${Math.round(pct)}% semantic`
  };
}

function checkContentUpdateSignals(blogPosts: ParsedPage[], practicePages: ParsedPage[]): CheckResult {
  const maxPoints = 4;
  const contentPages = [...blogPosts, ...practicePages];

  if (contentPages.length === 0) {
    return {
      name: 'Content Maintenance', category: 'contentDiversity', passed: false,
      score: 0, maxPoints,
      detail: 'No content to evaluate for maintenance signals.',
      headline: 'No content found'
    };
  }

  // Check for dateModified signals
  const withModifiedDate = contentPages.filter(p => p.modifiedDate && p.publishDate &&
    p.modifiedDate.getTime() > p.publishDate.getTime());

  // Check copyright year
  const allText = contentPages.map(p => p.bodyText + ' ' + p.html).join(' ');
  const currentYear = new Date().getFullYear();
  const hasCopyrightCurrent = new RegExp(`©\\s*${currentYear}|copyright\\s*${currentYear}`, 'i').test(allText);

  // Check for "last updated" visible text
  const hasLastUpdated = /last\s*updated|updated\s*on|revised|modified/i.test(allText);

  let score = 0;
  if (withModifiedDate.length > 0 && (hasCopyrightCurrent || hasLastUpdated)) score = 4;
  else if (withModifiedDate.length > 0 || hasLastUpdated) score = 3;
  else if (hasCopyrightCurrent) score = 2;
  else score = 0;

  const passed = score >= 3;
  return {
    name: 'Content Maintenance', category: 'contentDiversity', passed,
    score: Math.min(score, maxPoints), maxPoints,
    detail: passed
      ? `Content maintenance signals found.${withModifiedDate.length > 0 ? ` ${withModifiedDate.length} page(s) show dateModified.` : ''}${hasLastUpdated ? ' "Last updated" dates visible.' : ''}${hasCopyrightCurrent ? ` ${currentYear} copyright.` : ''} Maintained content ranks better.`
      : `Weak content maintenance signals.${!hasLastUpdated ? ' No "last updated" dates shown.' : ''}${!hasCopyrightCurrent ? ` Copyright not updated to ${currentYear}.` : ''} Regularly updating content is a key freshness signal.`,
    headline: passed ? 'Content actively maintained' : 'Weak maintenance signals'
  };
}

// ═══════════════════════════════════════════════════════════
// MAIN SCAN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════
export async function scanWebsite(inputUrl: string): Promise<ScanResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  let url = inputUrl;
  if (!url.startsWith('http')) url = 'https://' + url;
  const origin = new URL(url).origin;
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const isSSL = url.startsWith('https');

  // Parallel fetch: homepage + Cloudflare crawl
  const [homepageRes, crawlOutcome] = await Promise.all([
    fetchResource(url),
    crawlSite({ url, limit: 75, maxDepth: 3, formats: ['html'], maxAge: 3600 }).catch((e) => {
      errors.push(`Crawl error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
  ]);

  const crawlResult: CrawlResult | null = crawlOutcome ?? null;
  let usedCrawl = false;

  // Debug info
  if (crawlResult) {
    const statusCounts: Record<string, number> = {};
    for (const cp of crawlResult.pages) statusCounts[cp.status] = (statusCounts[cp.status] || 0) + 1;
    errors.push(`Crawl: ${crawlResult.status}, ${crawlResult.pages.length} pages (${JSON.stringify(statusCounts)})`);
  } else {
    errors.push(`Crawl: null, homepage fetch status: ${homepageRes.status}, hasContent: ${!!homepageRes.content}`);
  }

  // ── STEP 1: Build page collection, prioritizing crawl data ──
  const allPages: ParsedPage[] = [];
  const seenUrls = new Set<string>();

  // Process ALL crawl pages first (they use real browser rendering)
  if (crawlResult) {
    for (const crawlPage of crawlResult.pages) {
      if (crawlPage.status !== 'completed' || !crawlPage.html) continue;
      try {
        const pageUrl = new URL(crawlPage.url);
        if (pageUrl.hostname.replace(/^www\./, '') !== domain) continue;
        const normalized = pageUrl.origin + pageUrl.pathname.replace(/\/$/, '');
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);
        seenUrls.add(crawlPage.url); // Also add original URL
        const parsed = parsePage(crawlPage.html, crawlPage.url, domain);
        allPages.push(parsed);
        usedCrawl = true;
      } catch {}
    }
  }

  // Get homepage — prefer crawl version, fall back to direct fetch
  let homepage = allPages.find(p => {
    try { const path = new URL(p.url).pathname; return path === '/' || path === ''; } catch { return false; }
  }) ?? null;

  if (!homepage && homepageRes.content) {
    homepage = parsePage(homepageRes.content, url, domain);
    if (!seenUrls.has(url)) {
      allPages.unshift(homepage);
      seenUrls.add(url);
    }
  } else if (!homepage && crawlResult) {
    // Try crawl homepage with trailing slash variations
    const crawlHome = crawlResult.pages.find(p => {
      if (p.status !== 'completed' || !p.html) return false;
      try { const path = new URL(p.url).pathname; return path === '/' || path === ''; } catch { return false; }
    });
    if (crawlHome?.html) {
      homepage = parsePage(crawlHome.html, url, domain);
      if (!seenUrls.has(url)) {
        allPages.unshift(homepage);
        seenUrls.add(url);
      }
    }
  }

  if (!homepage) errors.push('Could not fetch homepage');

  // ── STEP 2: If crawl had few pages, supplement with direct fetches ──
  if (homepage && allPages.length < 10) {
    const subUrls = discoverSubpages(homepage, url, domain)
      .filter(u => !seenUrls.has(u) && !seenUrls.has(u.replace(/\/$/, '')))
      .slice(0, 15);
    if (subUrls.length > 0) {
      const subResults = await Promise.allSettled(
        subUrls.map(async (subUrl) => {
          const res = await fetchResource(subUrl, 6000);
          if (res.content && res.status === 200) return parsePage(res.content, subUrl, domain);
          return null;
        })
      );
      for (const r of subResults) {
        if (r.status === 'fulfilled' && r.value) {
          const normalized = new URL(r.value.url).origin + new URL(r.value.url).pathname.replace(/\/$/, '');
          if (!seenUrls.has(normalized)) {
            allPages.push(r.value);
            seenUrls.add(normalized);
            seenUrls.add(r.value.url);
          }
        }
      }
    }
  }

  // ── STEP 3: Discover and fetch blog posts from blog index pages ──
  const blogIndexPages = allPages.filter(p =>
    /\/([a-z-]*(?:blog|news|article|insight|resource)s?)\/?$/i.test(p.url)
  );
  if (blogIndexPages.length > 0) {
    const postUrls = discoverBlogPosts(blogIndexPages, domain)
      .filter(u => !seenUrls.has(u) && !seenUrls.has(u.replace(/\/$/, '')))
      .slice(0, 10);
    if (postUrls.length > 0) {
      const postResults = await Promise.allSettled(
        postUrls.map(async (postUrl) => {
          const res = await fetchResource(postUrl, 6000);
          if (res.content && res.status === 200) return parsePage(res.content, postUrl, domain);
          return null;
        })
      );
      for (const r of postResults) {
        if (r.status === 'fulfilled' && r.value) {
          allPages.push(r.value);
          seenUrls.add(r.value.url);
        }
      }
    }
  }

  // Classify pages
  const blogPosts = allPages.filter(p => p.isBlogPost);
  const practicePages = allPages.filter(p => p.isPracticeAreaPage);

  // Run checks
  const checks: CheckResult[] = [];

  if (homepage) {
    // A: Blog & Publishing Engine (25 pts)
    checks.push(checkBlogExists(allPages, blogPosts));
    checks.push(checkPostVolume(blogPosts));
    checks.push(checkPublishingRecency(blogPosts));
    checks.push(checkPublishingCadence(blogPosts));

    // B: Content Quality & Readability (30 pts)
    checks.push(checkContentDepth(blogPosts, practicePages));
    checks.push(checkReadability(blogPosts, practicePages));
    checks.push(checkContentFormatting(blogPosts, practicePages));
    checks.push(checkThinContent(allPages));
    checks.push(checkParagraphStructure(blogPosts, practicePages));

    // C: Topical Authority & E-E-A-T (25 pts)
    checks.push(checkTopicClusters(blogPosts, practicePages));
    checks.push(checkAuthorAttribution(blogPosts));
    checks.push(checkAuthorCredentials(allPages));
    checks.push(checkArticleSchema(blogPosts));
    checks.push(checkContentCoverageGaps(blogPosts, practicePages, allPages));

    // D: Content Diversity & Engagement (20 pts)
    checks.push(checkVideoContent(allPages));
    checks.push(checkVisualRichness(blogPosts, practicePages));
    checks.push(checkDownloadableResources(allPages));
    checks.push(checkSemanticHTML(allPages));
    checks.push(checkContentUpdateSignals(blogPosts, practicePages));
  }

  // Aggregate
  const categoryMap: Record<string, CheckResult[]> = {
    blogEngine: [], contentQuality: [], topicalAuthority: [], contentDiversity: [],
  };
  for (const check of checks) {
    categoryMap[check.category]?.push(check);
  }

  function buildCategory(key: string, name: string): CategoryScore {
    const catChecks = categoryMap[key] || [];
    const score = catChecks.reduce((sum, c) => sum + c.score, 0);
    const maxPoints = catChecks.reduce((sum, c) => sum + c.maxPoints, 0);
    const percentage = maxPoints > 0 ? Math.round((score / maxPoints) * 100) : 0;
    return { name, score, maxPoints, percentage, grade: categoryGrade(percentage), checks: catChecks };
  }

  const categories = {
    blogEngine: buildCategory('blogEngine', 'Blog & Publishing Engine'),
    contentQuality: buildCategory('contentQuality', 'Content Quality & Readability'),
    topicalAuthority: buildCategory('topicalAuthority', 'Topical Authority & E-E-A-T'),
    contentDiversity: buildCategory('contentDiversity', 'Content Diversity & Engagement'),
  };

  const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
  const totalMax = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const overallScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  const { grade, label: gradeLabel } = gradeFromScore(overallScore);

  const headlines: string[] = [];
  const sortedByImpact = [...checks].sort((a, b) => b.maxPoints - a.maxPoints);
  const topPassing = sortedByImpact.find(c => c.passed);
  const topFailing = sortedByImpact.find(c => !c.passed);
  if (topPassing) headlines.push(topPassing.headline);
  if (topFailing) headlines.push(topFailing.headline);

  const firmName = homepage ? extractFirmName(homepage) : domain;

  return {
    url, domain, firmName, overallScore, grade, gradeLabel,
    categories, totalChecks: checks.length, passedChecks: checks.filter(c => c.passed).length,
    scanDurationMs: Date.now() - startTime, headlineFindings: headlines, errors,
    crawlEnhanced: usedCrawl,
    crawlPagesUsed: allPages.length,
    blogPostsFound: blogPosts.length,
    practiceAreaPagesFound: practicePages.length,
  };
}

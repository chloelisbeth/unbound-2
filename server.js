const express = require('express');
const path = require('path');
const { buildLandingContext } = require('./lib/landing-context');

// Boot DB module (constructs pool, injects into domain modules)
require('./db/index');
const lessonsDb = require('./db/lessons');
const lessonsRouter = require('./routes/lessons');
const pricingRouter = require('./routes/pricing');
const subscribeRouter = require('./routes/subscribe');
const worksheetsRouter = require('./routes/worksheets');
const { router: emailSequenceRouter, runEmailSequence } = require('./routes/email-sequence');
const resetRouter = require('./routes/reset');
const blogRouter = require('./routes/blog');
const analyticsRouter = require('./routes/analytics');
const { getAllArticles } = require('./lib/blog-articles');
const { recordPageView, trackConversion } = require('./lib/track');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Cookie-based session — SESSION_SECRET required in production
const SESSION_SECRET = process.env.SESSION_SECRET || 'REDACTED';
app.use(require('cookie-session')({
  name: 'session',
  secret: SESSION_SECRET,
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — persist progress
  sameSite: 'lax',
}));

// Analytics middleware — logs every page view and fires conversion events.
// All DB calls are fire-and-forget; never blocks the response.
// Funnel order: landing_view → module1_start → pricing_view → stripe_checkout_click → email_signup → reset_view → reset_purchase
app.use((req, res, next) => {
  // Skip static assets and internal endpoints
  if (req.path.startsWith('/api/internal') || req.path.startsWith('/api/analytics')) {
    return next();
  }

  // Record page view (non-blocking)
  recordPageView(req, req.path);

  // Fire landing_view on first hit to the homepage
  if (req.path === '/' && !req.session.analyticsLandingFired) {
    req.session.analyticsLandingFired = true;
    trackConversion(req, 'landing_view');
  }

  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// /health — Render health check (must stay at root, must return 200)
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Landing page
app.get('/', (_req, res) => {
  res.render('layout', buildLandingContext());
});

// Lesson pages
app.use('/learn', lessonsRouter);

// Pricing page and payment success — router handles /pricing and /pricing/success
app.use('/pricing', pricingRouter);

// Email capture — POST /api/subscribe
app.use('/api/subscribe', subscribeRouter);

// Worksheet PDF downloads — paid users only
app.use('/worksheets', worksheetsRouter);

// Internal: email nurture sequence job (also triggered by hourly setInterval below)
app.use('/api/internal/email-sequence', emailSequenceRouter);

// 5-Minute Reset — sales page, payment success, and PDF download
app.use('/reset', resetRouter);

// SEO blog — index at /blog, articles at /blog/:slug
app.use('/blog', blogRouter);

// Analytics API — page views, conversion events, summary data
app.use('/api/analytics', analyticsRouter);

// sitemap.xml — static sitemap for SEO crawlers
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://unbound-4300.polsia.app';
  const articles = getAllArticles();
  const articleUrls = articles.map((a) =>
    `  <url><loc>${base}/blog/${a.slug}</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/learn</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${base}/pricing</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${base}/blog</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${base}/reset</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
${articleUrls}
</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// Stripe success_url was set to /payment/success — redirect to canonical route
app.get('/payment/success', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(302, `/pricing/success${qs ? `?${qs}` : ''}`);
});

// API: lesson list for sidebar (used by client-side JS on lesson pages)
app.get('/api/lessons/:moduleSlug', async (req, res) => {
  try {
    const sessionId = req.session.uid || '';
    const mod = await lessonsDb.getModuleBySlug(req.params.moduleSlug);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const [lessons, completedIds] = await Promise.all([
      lessonsDb.getLessonsForModule(mod.id),
      lessonsDb.getCompletedLessonIds(sessionId),
    ]);

    const enriched = lessons.map((l) => ({
      slug: l.slug,
      title: l.title,
      sort_order: l.sort_order,
      duration_minutes: l.duration_minutes,
      completed: completedIds.has(l.id),
    }));

    res.json({ lessons: enriched });
  } catch (err) {
    console.error('API /api/lessons error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(port, () => {
  console.log(`Unbound running on port ${port}`);

  // Hourly email sequence job — runs in-process to avoid a separate worker service.
  // Fires once 30s after boot (in case of recent signups), then every hour.
  setTimeout(() => {
    runEmailSequence().catch((err) => console.error('email-sequence boot run error:', err));
    setInterval(() => {
      runEmailSequence().catch((err) => console.error('email-sequence interval error:', err));
    }, 60 * 60 * 1000); // 1 hour
  }, 30 * 1000); // 30s after boot
});

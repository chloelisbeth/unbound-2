/**
 * routes/analytics.js
 * Owns: GET /api/analytics/summary — aggregated metrics for internal use
 *       GET /api/track/checkout — redirect to Stripe after logging stripe_checkout_click event
 * Does NOT own: data collection (middleware handles page views; conversion events come from routes)
 */

const { Router } = require('express');
const analyticsDb = require('../db/analytics');
const { trackConversion } = require('../lib/track');

const router = Router();

// GET /api/track/checkout?tier=full — log stripe_checkout_click, redirect to Stripe
// Buttons in pricing.ejs and reset.ejs use this so we can track checkout intent server-side.
router.get('/checkout', (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://buy.stripe.com')) {
    return res.redirect('/pricing');
  }

  trackConversion(req, 'stripe_checkout_click', { tier: req.query.tier || null });
  res.redirect(url);
});

// GET /api/analytics/summary?period=7d
// Returns page views by path, unique sessions/day, conversion funnel, and referrer breakdown.
// No auth — keep this internal-only (not exposed on public-facing routes).
router.get('/summary', async (req, res) => {
  const period = req.query.period || '7d';
  let hours;
  switch (period) {
    case '24h': hours = 24; break;
    case '7d':  hours = 24 * 7; break;
    case '30d': hours = 24 * 30; break;
    default:    hours = 24 * 7;
  }

  try {
    const [
      totalPageViews,
      totalUniqueSessions,
      pageViewsByPath,
      sessionsPerDay,
      conversionEventCounts,
      totalConversions,
      referrerBreakdown,
      utmBreakdown,
    ] = await Promise.all([
      analyticsDb.getTotalPageViews(hours),
      analyticsDb.getTotalUniqueSessions(hours),
      analyticsDb.getPageViewsByPathAll(hours),
      analyticsDb.getUniqueSessionsPerDay(hours),
      analyticsDb.getConversionEventCounts(hours),
      analyticsDb.getTotalConversionEvents(hours),
      analyticsDb.getReferrerBreakdown(hours, 10),
      analyticsDb.getUtmBreakdown(hours, 10),
    ]);

    // Conversion funnel — in strict order so we can calc drop-off.
    // Order matters: the funnel analysis assumes this ordering.
    const FUNNEL_ORDER = [
      'landing_view',
      'module1_start',
      'pricing_view',
      'stripe_checkout_click',
      'email_signup',
      'reset_view',
      'reset_purchase',
    ];

    // Build funnel with counts from event counts map
    const eventCountMap = {};
    for (const row of conversionEventCounts) {
      eventCountMap[row.event_type] = row.count;
    }

    const funnel = FUNNEL_ORDER.map((eventType, index) => {
      const count = eventCountMap[eventType] || 0;
      const prevCount = index > 0 ? (eventCountMap[FUNNEL_ORDER[index - 1]] || 0) : count;
      const dropOff = prevCount > 0 ? Math.round(((prevCount - count) / prevCount) * 100) : null;
      return {
        event_type: eventType,
        count,
        drop_off_pct: dropOff,
      };
    });

    // Top paths (limit to 15 for readability)
    const topPaths = pageViewsByPath.slice(0, 15);

    res.json({
      period,
      total_page_views: totalPageViews,
      total_unique_sessions: totalUniqueSessions,
      total_conversion_events: totalConversions,
      top_paths: topPaths,
      sessions_per_day: sessionsPerDay,
      conversion_funnel: funnel,
      referrer_breakdown: referrerBreakdown,
      utm_breakdown: utmBreakdown,
    });
  } catch (err) {
    console.error('/api/analytics/summary error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = router;
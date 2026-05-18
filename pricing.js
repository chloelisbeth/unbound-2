/**
 * routes/pricing.js
 * Owns: /pricing page, /pricing/success payment verification, /pricing/restore purchase recovery
 * Does NOT own: lesson routing, session creation, Stripe API key management
 */

const express = require('express');
const router = express.Router();
const purchasesDb = require('../db/purchases');
const { baseSnippet: metaPixelBase, purchaseSnippet: metaPixelPurchase } = require('../lib/meta-pixel');
const { trackConversion } = require('../lib/track');

// Launch pricing window — set via env var or defaults to May 29, 2026 11:59 PM UTC
// To extend: set LAUNCH_PRICE_END_DATE=2026-06-15T23:59:59Z
// To end early: set LAUNCH_PRICE_END_DATE to a past date
const LAUNCH_PRICE_END = process.env.LAUNCH_PRICE_END_DATE
  ? new Date(process.env.LAUNCH_PRICE_END_DATE)
  : new Date('2026-05-29T23:59:59Z');

const LAUNCH_PRICE = 97;
const LAUNCH_STRIPE_URL = 'https://buy.stripe.com/7sY8wQ9DA16S5XjcFE3gk02';

function isLaunchWindowActive() {
  return new Date() < LAUNCH_PRICE_END;
}

// Tier definitions — single source of truth for prices and Stripe URLs
// During launch window, full tier price and URL are overridden dynamically
const TIERS = {
  full: {
    name: 'Full Course',
    price: 127,
    stripeUrl: 'https://buy.stripe.com/28EcN6dTQ9Do85r6hg3gk00',
    tier: 'full',
  },
  premium: {
    name: 'Premium',
    price: 197,
    stripeUrl: 'https://buy.stripe.com/fZu00kcPMdTEetP6hg3gk01',
    tier: 'premium',
  },
};

// GET /pricing — show pricing tiers
router.get('/', (req, res) => {
  // Fire pricing_view once per session
  if (!req.session.analyticsPricingViewFired) {
    req.session.analyticsPricingViewFired = true;
    trackConversion(req, 'pricing_view');
  }

  const showRestore = req.query.restore === '1';
  const restoreSuccess = req.query.restored === '1';
  const restoreError = req.query.restore_error || null;

  const launchActive = isLaunchWindowActive();

  // Build effective tiers — override full tier during launch window
  const effectiveTiers = {
    ...TIERS,
    full: launchActive
      ? { ...TIERS.full, price: LAUNCH_PRICE, stripeUrl: LAUNCH_STRIPE_URL, regularPrice: TIERS.full.price }
      : TIERS.full,
  };

  res.render('pricing', {
    title: 'Pricing — Unbound',
    tiers: effectiveTiers,
    showRestore,
    restoreSuccess,
    restoreError,
    launchActive,
    launchEndDate: LAUNCH_PRICE_END.toISOString(),
    metaPixelSnippet: metaPixelBase(),
  });
});

// POST /pricing/restore — re-link a purchase to the current session by email
router.post('/restore', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\\.[^\s@]+$/.test(email)) {
    return res.redirect('/pricing?restore=1&restore_error=invalid_email');
  }

  try {
    // Ensure session ID exists before restoring
    if (!req.session.uid) {
      req.session.uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    const purchase = await purchasesDb.restorePurchaseByEmail(email, req.session.uid);

    if (!purchase) {
      return res.redirect('/pricing?restore=1&restore_error=not_found');
    }

    // Cache tier in session so gating is instant
    req.session.unlockedTier = purchase.tier;

    res.redirect('/pricing?restored=1');
  } catch (err) {
    console.error('Restore purchase error:', err);
    res.redirect('/pricing?restore=1&restore_error=server_error');
  }
});

// GET /payment/success — verify payment with Polsia and record purchase
router.get('/success', async (req, res) => {
  const stripeSessionId = req.query.checkout_session_id || req.query.session_id;

  if (!stripeSessionId) {
    return res.redirect('/pricing?error=missing_session');
  }

  try {
    const response = await fetch(
      `${process.env.POLSIA_API_URL}/api/company-payments/verify?session_id=${stripeSessionId}`,
      { headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` } }
    );
    const data = await response.json();

    if (!data.verified) {
      return res.redirect('/pricing?error=payment_not_verified');
    }

    const { payment } = data;

    // Determine tier from product name
    const tier = payment.product_name?.toLowerCase().includes('premium') ? 'premium' : 'full';

    // Ensure session ID exists
    if (!req.session.uid) {
      req.session.uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    await purchasesDb.recordPurchase({
      sessionId: req.session.uid,
      email: payment.customer_email || null,
      stripeSessionId,
      productName: payment.product_name,
      amountCents: Math.round((payment.amount || 0) * 100),
      tier,
    });

    // Store unlock in session for instant gating (no DB lookup on every lesson)
    req.session.unlockedTier = tier;

    res.render('payment-success', {
      title: "Welcome to Unbound — You're in",
      email: payment.customer_email,
      tier,
      metaPixelSnippet: metaPixelBase() + metaPixelPurchase(
        Math.round((payment.amount || 0) * 100),
        (payment.currency || 'usd').toUpperCase(),
        tier
      ),
    });
  } catch (err) {
    console.error('Payment verification error:', err);
    res.redirect('/pricing?error=verification_failed');
  }
});

module.exports = router;
module.exports.TIERS = TIERS;
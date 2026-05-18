/**
 * routes/reset.js
 * Owns: /reset sales page, /reset/success payment verification + PDF email delivery,
 *       /reset/download token-gated PDF streaming
 * Does NOT own: course lessons, Stripe key management, subscriber DB state, Reset drip emails
 */

const express = require('express');
const router = express.Router();
const { baseSnippet: metaPixelBase, purchaseSnippet: metaPixelPurchase } = require('../lib/meta-pixel');
const { streamResetGuidePDF } = require('../lib/reset-guide');
const resetSeqDb = require('../db/reset-sequence');
const { trackConversion } = require('../lib/track');

const RESET_STRIPE_URL = 'https://buy.stripe.com/aFa7sM4jg16SetP5dc3gk03';
const RESET_PRICE = 12;
const APP_URL = 'https://unbound-4300.polsia.app';
const PROXY_URL = 'https://polsia.com/api/proxy/email/send';
const CONTACT_URL = 'https://polsia.com/api/proxy/email/contacts';

// GET /reset — sales page
router.get('/', (req, res) => {
  // Fire reset_view once per session
  if (!req.session.analyticsResetViewFired) {
    req.session.analyticsResetViewFired = true;
    trackConversion(req, 'reset_view');
  }

  res.render('reset', {
    title: '5-Minute Reset — Break the Loop Before It Breaks You',
    stripeUrl: RESET_STRIPE_URL,
    price: RESET_PRICE,
    metaPixelSnippet: metaPixelBase(),
  });
});

// GET /reset/success — verify payment, send delivery email, show confirmation
router.get('/success', async (req, res) => {
  const stripeSessionId = req.query.session_id || req.query.checkout_session_id;

  if (!stripeSessionId) {
    return res.redirect('/reset?error=missing_session');
  }

  try {
    const response = await fetch(
      `${process.env.POLSIA_API_URL}/api/company-payments/verify?session_id=${stripeSessionId}`,
      { headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` } }
    );
    const data = await response.json();

    if (!data.verified) {
      return res.redirect('/reset?error=payment_not_verified');
    }

    const { payment } = data;
    const email = payment.customer_email || null;
    const amountCents = Math.round((payment.amount || RESET_PRICE) * 100);
    const currency = (payment.currency || 'usd').toUpperCase();

    // Record buyer for nurture drip sequence (non-blocking, idempotent by email)
    if (email) {
      resetSeqDb.recordResetBuyer({ email, stripeSessionId }).catch((err) => {
        console.error('reset-sequence: recordResetBuyer error:', err.message);
      });
    }

    // Deliver PDF download link via email (non-blocking)
    if (email) {
      deliverResetGuideEmail(email, stripeSessionId).catch((err) => {
        console.error('5-Minute Reset email delivery error:', err.message);
      });
    }

    // Track reset purchase conversion (fire and forget)
    trackConversion(req, 'reset_purchase', { amount: payment.amount, currency: payment.currency });

    res.render('reset-success', {
      title: 'Your 5-Minute Reset is ready',
      email,
      downloadToken: stripeSessionId,
      metaPixelSnippet: metaPixelBase() + metaPixelPurchase(amountCents, currency, 'reset_guide'),
    });
  } catch (err) {
    console.error('Reset payment verification error:', err);
    res.redirect('/reset?error=verification_failed');
  }
});

// GET /reset/download?token=<stripeSessionId> — verify token, stream PDF
router.get('/download', async (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.status(403).send('Access token required. Please use the link from your purchase email or success page.');
  }

  try {
    const response = await fetch(
      `${process.env.POLSIA_API_URL}/api/company-payments/verify?session_id=${token}`,
      { headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` } }
    );
    const data = await response.json();

    if (!data.verified) {
      return res.status(403).send('Download link is invalid. Contact unbound@polsia.app for help.');
    }

    // Stream PDF on-the-fly — no disk write (Render filesystem is ephemeral)
    streamResetGuidePDF(res);
  } catch (err) {
    console.error('Reset download verification error:', err);
    res.status(500).send('Something went wrong. Please try again or contact unbound@polsia.app.');
  }
});

// ─── Email delivery ───────────────────────────────────────────────────────────

async function deliverResetGuideEmail(email, stripeSessionId) {
  // Register as known contact so future sends are not rate-limited
  await fetch(CONTACT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
    },
    body: JSON.stringify({ email, source: 'purchase' }),
  }).catch(() => {}); // non-fatal

  const downloadUrl = `${APP_URL}/reset/download?token=${encodeURIComponent(stripeSessionId)}`;
  const subject = 'Your 5-Minute Reset — download inside';

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
    },
    body: JSON.stringify({
      to: email,
      subject,
      body: buildPlainText(downloadUrl),
      html: buildHtml(downloadUrl),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Email proxy ${res.status}: ${text}`);
  }
}

const BASE_STYLES = `
  body { margin: 0; padding: 0; background: #f9f7f4; font-family: 'DM Sans', Arial, sans-serif; }
  .wrap { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; }
  .header { background: #3D5A47; padding: 28px 36px; }
  .header h1 { margin: 0; color: #fff; font-size: 20px; letter-spacing: 0.5px; }
  .header-sub { margin: 6px 0 0; color: rgba(255,255,255,0.65); font-size: 13px; }
  .body { padding: 32px 36px; color: #3d3530; font-size: 15px; line-height: 1.7; }
  .body p { margin: 0 0 16px; }
  .download-box { background: #F2E6DF; border: 1.5px solid #C4856A; border-radius: 10px; padding: 24px 28px; margin: 24px 0; text-align: center; }
  .download-label { font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #C4856A; margin-bottom: 10px; }
  .download-title { font-size: 20px; font-weight: 700; color: #3D5A47; margin-bottom: 5px; }
  .download-sub { font-size: 13px; color: #6B6B6B; margin-bottom: 20px; }
  .cta { display: inline-block; background: #3D5A47; color: #fff !important; text-decoration: none; padding: 14px 36px; border-radius: 100px; font-size: 15px; font-weight: 600; }
  .callout { background: #E8F0EA; border-left: 3px solid #3D5A47; padding: 16px 20px; border-radius: 4px; margin: 24px 0; font-size: 14px; color: #3d3530; line-height: 1.6; }
  .footer { padding: 20px 36px; font-size: 12px; color: #9a8a82; border-top: 1px solid #f0ebe6; }
  a { color: #C4856A; }
`;

function buildHtml(downloadUrl) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your 5-Minute Reset</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Unbound</h1>
      <p class="header-sub">Your 5-Minute Reset is ready to download.</p>
    </div>
    <div class="body">
      <p>Thank you for purchasing the 5-Minute Reset.</p>
      <p>This guide was built for one specific moment: the five minutes before you react. Before the text. Before the apology for something that isn't yours. Before the spiral takes over. Click below to download it now.</p>

      <div class="download-box">
        <div class="download-label">Your PDF Download</div>
        <div class="download-title">5-Minute Reset Guide</div>
        <div class="download-sub">9 pages · In-the-moment regulation tool · Keep on your phone</div>
        <a class="cta" href="${downloadUrl}">Download Your Guide →</a>
      </div>

      <div class="callout">
        <strong>How to use it:</strong> Save it to your phone. The next time you feel the loop starting — before you send the text, before you scan the room, before you fix the mood — open it. Five minutes. One breath. That's it.
      </div>

      <p>The guide includes pattern-specific resets for the four most common codependent loops, plus screenshot-ready quick-reference cards designed for your phone's camera roll.</p>

      <p>If you haven't tried Unbound's free module yet, it's a good companion to this guide. Module 1 walks through the psychology behind what the Reset helps you interrupt — six lessons, free, no account needed.</p>
      <p><a href="${APP_URL}/learn">Start the free module →</a></p>

      <p style="margin-top: 24px; font-size: 14px; color: #7a6a62;">Questions? Reply to this email or reach us at <a href="mailto:unbound@polsia.app">unbound@polsia.app</a>.</p>
    </div>
    <div class="footer">
      You received this because you purchased the 5-Minute Reset from Unbound.<br>
      <a href="${APP_URL}/reset">unbound-4300.polsia.app/reset</a>
    </div>
  </div>
</body>
</html>`;
}

function buildPlainText(downloadUrl) {
  return `Thank you for purchasing the 5-Minute Reset.

Download your guide here:
${downloadUrl}

This guide was built for the moment before you react — before the text, before the apology, before the spiral takes over.

Save it to your phone. Quick-reference cards are included for the four most common codependent loops.

If you haven't tried Unbound's free module, it's a good companion:
${APP_URL}/learn

Questions? Reply to this email or reach us at unbound@polsia.app.`;
}

module.exports = router;

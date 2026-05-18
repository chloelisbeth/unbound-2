/**
 * routes/subscribe.js
 * Owns: POST /api/subscribe — email capture endpoint for landing page and lesson prompts
 * Does NOT own: session management, lesson access control, payment state
 */

const { Router } = require('express');
const subscribersDb = require('../db/subscribers');
const { leadSnippet } = require('../lib/meta-pixel');
const { registerContact } = require('../lib/send-email');
const { trackConversion } = require('../lib/track');

const router = Router();

// Minimal email format check — not exhaustive, just catches obvious garbage
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// POST /api/subscribe
// Body: { email, name?, source? }
// Sets session.subscribed = true on success so the UI can react immediately.
// Returns: { success: true, already: bool }
router.post('/', async (req, res) => {
  const { email, name, source } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const cleanName = name ? String(name).trim().slice(0, 100) : null;
    const { inserted } = await subscribersDb.subscribe({
      email,
      name: cleanName,
      source: source || 'landing',
    });

    // Register with email proxy so nurture emails are never rate-limited.
    // Fire-and-forget — don't block the response on it.
    if (inserted) {
      registerContact({ email, name: cleanName }).catch(() => {});
    }

    // Mark session as subscribed regardless of dup — they're subscribed either way
    req.session.subscribed = true;

    // Track email signup conversion (fire and forget — never blocks)
    trackConversion(req, 'email_signup', { source: source || 'landing' });

    return res.json({ success: true, already: !inserted, metaPixelLead: leadSnippet() });
  } catch (err) {
    console.error('subscribe error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;

/**
 * routes/worksheets.js
 * Owns: /worksheets/:slug — PDF download routes for Module 2 companion worksheets
 * Does NOT own: purchase verification (uses purchasesDb), PDF generation (lib/worksheets.js)
 *
 * Access gate: all worksheets require a paid purchase (full or premium tier).
 * Unauthenticated users are redirected to /pricing.
 */

const express = require('express');
const router = express.Router();
const purchasesDb = require('../db/purchases');
const { streamWorksheetPDF, getWorksheet } = require('../lib/worksheets');

// Check if session has paid access (session cache first, DB fallback)
async function hasPaidAccess(req) {
  if (req.session.unlockedTier === 'full' || req.session.unlockedTier === 'premium') {
    return true;
  }
  if (!req.session.uid) return false;
  const access = await purchasesDb.hasAccess(req.session.uid, 'full');
  if (access) req.session.unlockedTier = 'full';
  return access;
}

// GET /worksheets/:slug — stream PDF if paid
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const worksheet = getWorksheet(slug);
    if (!worksheet) {
      return res.status(404).render('error', { message: 'Worksheet not found.' });
    }

    const paid = await hasPaidAccess(req);
    if (!paid) {
      // Redirect to pricing with a hint that this content requires purchase
      return res.redirect('/pricing?reason=worksheet');
    }

    const streamed = streamWorksheetPDF(slug, res);
    if (!streamed) {
      return res.status(404).render('error', { message: 'Worksheet not found.' });
    }
  } catch (err) {
    console.error('Worksheet download error:', err);
    res.status(500).render('error', { message: 'Something went wrong generating the worksheet.' });
  }
});

module.exports = router;

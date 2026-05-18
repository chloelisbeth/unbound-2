/**
 * routes/email-sequence.js
 * Owns: POST /api/internal/email-sequence — runs the nurture sequence job for both
 *       landing-page subscribers (3-email course welcome drip) and Reset guide buyers (3-email upsell drip)
 * Does NOT own: email templates (lib/send-email.js, lib/send-reset-emails.js), DB state (db/email-sequence.js, db/reset-sequence.js)
 *
 * Called internally on a setInterval timer from server.js (every hour).
 * Protected by INTERNAL_JOB_SECRET so it can't be triggered externally.
 */

const { Router } = require('express');
const emailSeqDb = require('../db/email-sequence');
const { sendEmail1, sendEmail2, sendEmail3 } = require('../lib/send-email');
const resetSeqDb = require('../db/reset-sequence');
const { sendResetEmail1, sendResetEmail2, sendResetEmail3 } = require('../lib/send-reset-emails');

const router = Router();

// Shared runner — also called directly from server.js timer to avoid HTTP round-trip
async function runEmailSequence() {
  const results = {
    subscribers: { email1: 0, email2: 0, email3: 0, errors: 0 },
    reset: { email1: 0, email2: 0, email3: 0, errors: 0 },
  };

  // Process each sequence in parallel batches. We mark-then-send to avoid
  // duplicate sends if the job runs again before the send confirms — acceptable
  // tradeoff for a low-volume drip without a proper queue.
  // Chosen order: mark sent first, then send. If send fails, record stays
  // marked (won't retry), which is preferable to double-sending.

  async function processGroup(pending, markFn, sendFn, emailNum, bucket) {
    for (const record of pending) {
      try {
        await markFn(record.id, emailNum);
        await sendFn(record);
        results[bucket][`email${emailNum}`]++;
      } catch (err) {
        // Don't let one failure kill the whole batch
        console.error(`email-sequence: ${bucket} email${emailNum} failed for id ${record.id}:`, err.message);
        results[bucket].errors++;
      }
    }
  }

  const [pending1, pending2, pending3, resetPending1, resetPending2, resetPending3] = await Promise.all([
    emailSeqDb.getPendingEmail1(),
    emailSeqDb.getPendingEmail2(),
    emailSeqDb.getPendingEmail3(),
    resetSeqDb.getPendingResetEmail1(),
    resetSeqDb.getPendingResetEmail2(),
    resetSeqDb.getPendingResetEmail3(),
  ]);

  // Run all groups sequentially to stay within proxy rate limits
  await processGroup(pending1, emailSeqDb.markEmailSent, sendEmail1, 1, 'subscribers');
  await processGroup(pending2, emailSeqDb.markEmailSent, sendEmail2, 2, 'subscribers');
  await processGroup(pending3, emailSeqDb.markEmailSent, sendEmail3, 3, 'subscribers');
  await processGroup(resetPending1, resetSeqDb.markResetEmailSent, sendResetEmail1, 1, 'reset');
  await processGroup(resetPending2, resetSeqDb.markResetEmailSent, sendResetEmail2, 2, 'reset');
  await processGroup(resetPending3, resetSeqDb.markResetEmailSent, sendResetEmail3, 3, 'reset');

  return results;
}

// POST /api/internal/email-sequence
// Guarded by shared secret — call from cron or internal timer only
router.post('/', async (req, res) => {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (secret && req.headers['x-job-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const results = await runEmailSequence();
    console.log('email-sequence job complete:', results);
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('email-sequence job error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router, runEmailSequence };

/**
 * routes/lessons.js
 * Owns: all /learn routes — module overview, lesson pages, progress marking, paid content gating
 * Does NOT own: user auth, payment processing, session creation (sessions come from cookie-session middleware)
 */

const express = require('express');
const router = express.Router();
const lessonsDb = require('../db/lessons');
const purchasesDb = require('../db/purchases');
const { baseSnippet: metaPixelBase } = require('../lib/meta-pixel');
const { getWorksheetForLesson, getAllWorksheets } = require('../lib/worksheets');
const { trackConversion } = require('../lib/track');

// Module 1 is always free; all other modules require a paid purchase.
// Must match the actual slug in the modules table ('recognizing-the-pattern'), not a generic label.
const FREE_MODULE_SLUG = 'recognizing-the-pattern';

// Check if the current session has access to a given module slug
// Uses session cache first, falls back to DB (handles cookie-clear scenarios)
async function checkModuleAccess(req, moduleSlug) {
  if (moduleSlug === FREE_MODULE_SLUG) return true;

  const sessionId = req.session.uid;
  if (!sessionId) return false;

  // Fast path: session already stores unlocked tier
  if (req.session.unlockedTier === 'full' || req.session.unlockedTier === 'premium') {
    return true;
  }

  // Slow path: DB check (handles case where session cookie was regenerated)
  const access = await purchasesDb.hasAccess(sessionId, 'full');
  if (access) {
    // Cache in session so subsequent requests are instant
    req.session.unlockedTier = 'full';
  }
  return access;
}

// Ensure session has an ID for progress tracking (anonymous session-based)
function getSessionId(req) {
  if (!req.session.uid) {
    // Stable random ID, stays in cookie-session across visits
    req.session.uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return req.session.uid;
}

// GET /learn — module overview with lesson list and progress
router.get('/', async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const modules = await lessonsDb.getAllModules();
    const isPaid = await checkModuleAccess(req, 'module-2');

    // For each module, get lessons + completion state
    const modulesWithProgress = await Promise.all(
      modules.map(async (mod) => {
        const lessons = await lessonsDb.getLessonsForModule(mod.id);
        const completedIds = await lessonsDb.getCompletedLessonIds(sessionId);
        const lessonsWithStatus = lessons.map((l) => ({
          ...l,
          completed: completedIds.has(l.id),
        }));
        const completedCount = lessonsWithStatus.filter((l) => l.completed).length;
        const resumeSlug = await lessonsDb.getFirstIncompleteLessonSlug(sessionId, mod.id);
        return {
          ...mod,
          lessons: lessonsWithStatus,
          completedCount,
          resumeSlug,
        };
      })
    );

    res.render('lessons/index', {
      title: 'Your Course',
      modules: modulesWithProgress,
      isPaid,
      worksheets: isPaid ? getAllWorksheets() : [],
      metaPixelSnippet: metaPixelBase(),
    });
  } catch (err) {
    console.error('Error loading module overview:', err);
    res.status(500).render('error', { message: 'Something went wrong loading the course.' });
  }
});

// GET /learn/:moduleSlug/:lessonSlug — individual lesson page
router.get('/:moduleSlug/:lessonSlug', async (req, res) => {
  const { moduleSlug, lessonSlug } = req.params;
  try {
    const sessionId = getSessionId(req);

    // Fire module1_start once per session when they first access Module 1
    if (moduleSlug === FREE_MODULE_SLUG && !req.session.analyticsModule1Fired) {
      req.session.analyticsModule1Fired = true;
      trackConversion(req, 'module1_start');
    }

    const lesson = await lessonsDb.getLessonBySlug(moduleSlug, lessonSlug);

    if (!lesson) {
      return res.status(404).render('error', { message: 'Lesson not found.' });
    }

    // Gate paid modules — show soft paywall instead of 403
    // M2L1 gets an extended free preview; see previewParagraphs logic below.
    const hasAccess = await checkModuleAccess(req, moduleSlug);
    if (!hasAccess) {
      // Module 2, Lesson 1 gets a free extended preview to create desire before the gate.
      // Show the full loop walkthrough (everything up to "What makes this hard") as free content.
      // The insight paragraphs + Try This section stay behind the paywall.
      let previewParagraphs = null;
      if (Number(lesson.sort_order) === 1) {
        const allParas = lesson.content.split(/\n\n+/);
        // The loop steps are paragraphs 0-8 (intro, "That spiral", "Here's how it runs:",
        // then the five ** steps, each a paragraph). Everything from "What makes this hard…"
        // onward — where the actionable value starts — stays gated.
        previewParagraphs = allParas.slice(0, 9);
      }

      return res.render('lessons/paywall', {
        title: `${lesson.title} — Unbound`,
        lesson,
        moduleSlug,
        previewParagraphs,
        metaPixelSnippet: metaPixelBase(),
      });
    }

    const [completedIds, adjacent] = await Promise.all([
      lessonsDb.getCompletedLessonIds(sessionId),
      lessonsDb.getAdjacentLessons(lesson.module_id, lesson.sort_order),
    ]);

    // Companion worksheet for this lesson (if one exists and user has paid access)
    const lessonWorksheet = getWorksheetForLesson(lesson.slug);

    res.render('lessons/lesson', {
      title: lesson.title,
      lesson,
      moduleSlug,
      completed: completedIds.has(lesson.id),
      prev: adjacent.prev,
      next: adjacent.next,
      subscribed: !!req.session.subscribed,
      isPaid: hasAccess,
      worksheetSlug: (hasAccess && lessonWorksheet) ? lessonWorksheet.slug : null,
      worksheetTitle: (hasAccess && lessonWorksheet) ? lessonWorksheet.title : null,
      metaPixelSnippet: metaPixelBase(),
    });
  } catch (err) {
    console.error('Error loading lesson:', err);
    res.status(500).render('error', { message: 'Something went wrong loading this lesson.' });
  }
});

// POST /learn/:moduleSlug/:lessonSlug/complete — mark lesson done
router.post('/:moduleSlug/:lessonSlug/complete', async (req, res) => {
  const { moduleSlug, lessonSlug } = req.params;
  try {
    const sessionId = getSessionId(req);
    const lesson = await lessonsDb.getLessonBySlug(moduleSlug, lessonSlug);

    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    // Prevent marking paid lessons complete without access
    const hasAccess = await checkModuleAccess(req, moduleSlug);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Purchase required' });
    }

    await lessonsDb.markLessonComplete(sessionId, lesson.id);

    // For XHR requests (from fetch), return JSON; otherwise redirect
    if (req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true });
    }

    // Find next lesson to auto-advance
    const adjacent = await lessonsDb.getAdjacentLessons(lesson.module_id, lesson.sort_order);
    if (adjacent.next) {
      return res.redirect(`/learn/${moduleSlug}/${adjacent.next.slug}`);
    }
    return res.redirect(`/learn`);
  } catch (err) {
    console.error('Error marking lesson complete:', err);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

module.exports = router;

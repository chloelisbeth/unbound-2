/**
 * routes/blog.js
 * Owns: /blog (index) and /blog/:slug (individual articles)
 * Does NOT own: article content (see lib/blog-articles.js), lesson routing, payments
 */

const express = require('express');
const router = express.Router();
const { getAllArticles, getArticleBySlug } = require('../lib/blog-articles');
const { baseSnippet: metaPixelBase } = require('../lib/meta-pixel');

// GET /blog — article index
router.get('/', (req, res) => {
  const articles = getAllArticles();
  res.render('blog/index', {
    articles,
    metaPixelSnippet: metaPixelBase,
    pageTitle: 'Blog — Unbound',
    metaDescription: 'Articles on codependency, people-pleasing, and learning to stop losing yourself in relationships.',
  });
});

// GET /blog/:slug — individual article
router.get('/:slug', (req, res) => {
  const article = getArticleBySlug(req.params.slug);
  if (!article) {
    return res.status(404).render('error', { message: 'Article not found.' });
  }
  res.render('blog/article', {
    article,
    metaPixelSnippet: metaPixelBase,
  });
});

module.exports = router;

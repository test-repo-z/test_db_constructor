import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { webController } from '../controllers/webController.js';
import { apiController } from '../controllers/apiController.js';

export function buildRouter(service, { rateLimitPerMinute }) {
  const web = webController(service);
  const api = apiController(service);
  // Reconstruction and diff decompress and parse full article texts: rate-limit them per client.
  const expensive = rateLimit({ windowMs: 60_000, limit: rateLimitPerMinute, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { status: 429, code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } } });

  const r = Router();
  r.get('/', web.home);
  r.get('/about', web.about);
  r.get('/articles/:id', web.article);
  r.get('/articles/:id/as-of', expensive, web.asOf);
  r.get('/articles/:id/diff', expensive, web.diff);
  r.get('/articles/:id/history', web.history);
  r.get('/articles/:id/temporal', expensive, web.temporal);

  r.get('/api/coverage', api.coverage);
  r.get('/api/articles', api.articles);
  r.get('/api/articles/:id', api.article);
  r.get('/api/articles/:id/as-of', expensive, api.asOf);
  r.get('/api/articles/:id/diff', expensive, api.diff);
  r.get('/api/articles/:id/history', api.history);
  return r;
}

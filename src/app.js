// Express application factory (no listening here, so tests can mount it on an ephemeral port).
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { ROOT_DIR, config } from './config/index.js';
import { ArticleRepository } from './repositories/articleRepository.js';
import { HistoryRepository } from './repositories/historyRepository.js';
import { ContentRepository } from './repositories/contentRepository.js';
import { TimeMachineService } from './services/timeMachineService.js';
import { buildRouter } from './routes/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import * as viewHelpers from './views/helpers.js';

export function createApp({ pool, rateLimitPerMinute = config.http.rateLimitPerMinute, logRequests = true }) {
  const service = new TimeMachineService({
    articleRepository: new ArticleRepository(pool),
    historyRepository: new HistoryRepository(pool),
    contentRepository: new ContentRepository(pool),
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT_DIR, 'src', 'views'));
  app.set('query parser', 'simple');
  Object.assign(app.locals, viewHelpers, { coverage: service.coverage() });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        // The app is usually served over plain HTTP (localhost / Docker); do not rewrite asset URLs to https.
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  if (logRequests) app.use(requestLogger);
  app.use('/static', express.static(path.join(ROOT_DIR, 'src', 'public'), { maxAge: '1h' }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });
  app.use(buildRouter(service, { rateLimitPerMinute }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

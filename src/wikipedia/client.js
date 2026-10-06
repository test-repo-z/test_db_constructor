// A deliberately polite MediaWiki Action API client.
//  * serialises requests and enforces a minimum interval between them (rate limiting);
//  * sends a descriptive User-Agent with contact information (Wikimedia policy);
//  * sends `maxlag` so that we back off when the database replicas are lagging;
//  * retries transient failures (network errors, 429, 5xx, maxlag) with bounded exponential backoff + jitter,
//    honouring Retry-After when the server provides it;
//  * never retries client errors (4xx other than 429) or API errors that are not transient.
import { createLogger } from '../lib/logger.js';

const log = createLogger('wikipedia');

export class WikipediaApiError extends Error {
  constructor(message, { code, status, transient = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.transient = transient;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  // attempt is 1-based; full jitter in [exp/2, exp], capped.
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export class WikipediaClient {
  constructor({ apiUrl, userAgent, minRequestIntervalMs = 300, maxRetries = 6, retryBaseDelayMs = 1000,
    retryMaxDelayMs = 30000, requestTimeoutMs = 60000, maxlagSeconds = 5, fetchImpl = globalThis.fetch }) {
    this.apiUrl = apiUrl;
    this.userAgent = userAgent;
    this.minInterval = minRequestIntervalMs;
    this.maxRetries = maxRetries;
    this.baseDelay = retryBaseDelayMs;
    this.maxDelay = retryMaxDelayMs;
    this.timeout = requestTimeoutMs;
    this.maxlag = maxlagSeconds;
    this.fetch = fetchImpl;
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
    this.stats = { requests: 0, retries: 0, bytes: 0 };
  }

  /** Serialised GET against the Action API. `params` are merged with format=json&formatversion=2. */
  query(params) {
    const run = () => this.#requestWithRetry(params);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #throttle() {
    const wait = this.lastRequestAt + this.minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async #requestWithRetry(params) {
    const search = new URLSearchParams({ format: 'json', formatversion: '2', errorformat: 'plaintext', ...params });
    if (this.maxlag) search.set('maxlag', String(this.maxlag));
    const url = `${this.apiUrl}?${search}`;
    for (let attempt = 1; ; attempt++) {
      await this.#throttle();
      try {
        return await this.#requestOnce(url);
      } catch (err) {
        const transient = err.transient ?? true; // network errors are transient
        if (!transient || attempt > this.maxRetries) {
          log.error('request failed permanently', { attempt, error: err.message, code: err.code, params: summarize(params) });
          throw err;
        }
        const delay = err.retryAfterMs ?? backoffDelay(attempt, this.baseDelay, this.maxDelay);
        this.stats.retries++;
        log.warn('transient failure, retrying', { attempt, delayMs: delay, error: err.message, code: err.code });
        await sleep(delay);
      }
    }
  }

  async #requestOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res;
    try {
      this.stats.requests++;
      res = await this.fetch(url, {
        headers: { 'User-Agent': this.userAgent, 'Api-User-Agent': this.userAgent, 'Accept-Encoding': 'gzip' },
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = new WikipediaApiError(`network error: ${e.message}`, { transient: true });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 || res.status >= 500) {
      const err = new WikipediaApiError(`HTTP ${res.status}`, { status: res.status, transient: true });
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = Math.min(retryAfter * 1000, this.maxDelay * 2);
      throw err;
    }
    if (!res.ok) throw new WikipediaApiError(`HTTP ${res.status}`, { status: res.status, transient: false });
    const text = await res.text();
    this.stats.bytes += text.length;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new WikipediaApiError('invalid JSON response', { transient: true });
    }
    if (body.errors?.length || body.error) {
      const first = body.errors?.[0] ?? body.error;
      const code = first.code;
      // maxlag / ratelimited: back off; internal_api_error_*: a server-side exception (e.g. a
      // DBConnectionError in MediaWiki's database layer), which is transient from the client's view.
      const transient = code === 'maxlag' || code === 'ratelimited' || String(code).startsWith('internal_api_error_');
      const err = new WikipediaApiError(`API error ${code}: ${first.text ?? first.info ?? ''}`, { code, transient });
      if (code === 'maxlag' && Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    if (body.warnings) log.debug('API warnings', { warnings: body.warnings });
    return body;
  }
}

function summarize(params) {
  const out = { ...params };
  for (const k of Object.keys(out)) if (String(out[k]).length > 120) out[k] = String(out[k]).slice(0, 117) + '...';
  return out;
}

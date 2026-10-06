// Wikitext -> safe HTML.
//
// Storage keeps the exact wikitext (deterministic, verifiable by SHA-1). Rendering happens at
// read time with wtf_wikipedia, an offline parser: no request to Wikipedia is needed to display
// a historical revision. Trade-off: templates (infoboxes, citation templates, math) are not
// expanded the way MediaWiki would, so the rendering is an approximation; the exact text is
// always available in the "wikitext" view, and every page links to Wikipedia's own permalink.
//
// Security: the parser output is treated as untrusted and passed through sanitize-html with a
// strict allow-list (no scripts, no event handlers, no inline styles, no images, only http(s)
// links). The Content-Security-Policy set in app.js is a second, independent layer.
import wtf from 'wtf_wikipedia';
import wtfHtml from 'wtf-plugin-html';
import sanitizeHtml from 'sanitize-html';
import { config } from '../config/index.js';

wtf.extend(wtfHtml);

const WIKI_BASE = config.wikipedia.articleBaseUrl; // https://en.wikipedia.org/wiki/

export const SANITIZE_OPTIONS = Object.freeze({
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'br', 'hr', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'],
  allowedAttributes: { a: ['href', 'title', 'rel', 'target'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], '*': ['class'] },
  allowedClasses: { '*': ['section', 'text', 'paragraph', 'sentence', 'link', 'list', 'table', 'infobox', 'reference', 'heading'] },
  allowedSchemes: ['http', 'https'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      let href = attribs.href ?? '';
      if (href.startsWith('./')) href = WIKI_BASE + encodeURI(decodeURISafe(href.slice(2)).replace(/ /g, '_'));
      if (!/^https?:\/\//i.test(href)) return { tagName: 'span', attribs: {} };
      return { tagName: 'a', attribs: { href, rel: 'nofollow noopener noreferrer', target: '_blank', class: 'link' } };
    },
  },
});

function decodeURISafe(s) {
  try { return decodeURI(s); } catch { return s; }
}

export function sanitize(html) {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/**
 * Renders wikitext. Returns { html, text, ok, error }.
 * `html` is sanitized and safe to embed; `text` is plain text (used by the text diff).
 */
export function renderWikitext(wikitext) {
  try {
    const doc = wtf(wikitext);
    return { html: sanitize(doc.html()), text: doc.text(), ok: true, error: null };
  } catch (err) {
    return { html: '', text: '', ok: false, error: `parser failed: ${err.message}` };
  }
}

/** Plain text only (cheaper than html when only the diff needs it). */
export function plainText(wikitext) {
  try {
    return wtf(wikitext).text();
  } catch {
    return wikitext;
  }
}

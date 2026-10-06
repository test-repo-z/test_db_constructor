import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWikitext, sanitize } from '../../src/services/renderService.js';

test('sanitizer removes scripts, event handlers, inline styles, images and dangerous URLs', () => {
  const out = sanitize('<p onclick="x()" style="color:red">hi<script>alert(1)</script><img src=x onerror=alert(2)>' +
    '<a href="javascript:alert(3)">j</a><a href="data:text/html,x">d</a><iframe src="https://evil"></iframe><svg onload=alert(4)></svg></p>');
  assert.doesNotMatch(out, /script|onerror|onclick|style=|<img|javascript:|data:|iframe|<svg|onload/i);
  assert.match(out, /hi/);
});

test('internal wiki links become absolute en.wikipedia.org links that open safely', () => {
  const out = sanitize('<a class="link" href="./Quantum_mechanics">QM</a>');
  assert.match(out, /href="https:\/\/en\.wikipedia\.org\/wiki\/Quantum_mechanics"/);
  assert.match(out, /rel="nofollow noopener noreferrer"/);
});

test('wikitext with embedded HTML/script renders without executable content', () => {
  const r = renderWikitext("'''Bold''' text.\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n[javascript:alert(3) x]\n== H ==\n* item");
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.html, /<script|onerror|<img|href="javascript:/i); // "javascript:" may survive only as inert text
  assert.doesNotMatch(r.html, /<a [^>]*href="(?!https?:)/i);
  assert.match(r.html, /<b>Bold<\/b>/);
  assert.match(r.text, /Bold text/);
});

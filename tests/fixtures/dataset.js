// Fixture revision histories used by integration and e2e tests. All instants are inside the
// configured window (2021-09-22 .. 2026-09-22) unless marked as baseline.
//
// Page 1001 "Alpha":   baseline before the window, regular edits, two edits in the SAME SECOND,
//                      a hidden (revision-deleted) revision, an XSS attempt in the latest text.
// Page 1002 "Beta":    created INSIDE the window (no revision before 2022-03-01).
// Page 1003 "Gamma":   a single revision long before the window (never edited since).
export const ALPHA = 1001;
export const BETA = 1002;
export const GAMMA = 1003;

const text = (n, extra = '') => `'''Alpha''' is a test article.\n\n== Section ==\nVersion ${n} of the text.${extra}\n\n== See also ==\n* [[Beta]]\n`;

export function fixturePages() {
  return new Map([
    [ALPHA, [
      { revid: 100, timestamp: '2020-05-01T10:00:00Z', text: text(0) },                       // baseline
      { revid: 110, timestamp: '2021-10-01T12:00:00Z', text: text(1) },
      { revid: 120, timestamp: '2022-06-15T08:30:00Z', text: text(2, '\nA new paragraph.') },
      { revid: 130, timestamp: '2022-06-15T08:30:00Z', text: text(3, '\nA new paragraph, fixed.') }, // same second as 120
      { revid: 140, timestamp: '2023-03-15T10:30:00Z', text: text(4) },
      { revid: 150, timestamp: '2023-03-15T10:30:05Z', text: text(5) },                          // 5 s later
      { revid: 160, timestamp: '2024-01-10T00:00:00Z', text: text(6), hidden: true },
      { revid: 170, timestamp: '2025-02-01T09:00:00Z', text: text(1) },                          // revert to text #1 (dedup)
      { revid: 180, timestamp: '2026-05-05T05:05:05Z', text: text(7, '\n<script>alert(1)</script><img src=x onerror=alert(2)> [javascript:alert(3) bad link]') },
    ]],
    [BETA, [
      { revid: 200, timestamp: '2022-03-01T00:00:00Z', text: "'''Beta''' is new." },
      { revid: 210, timestamp: '2024-07-07T07:07:07Z', text: "'''Beta''' is new and improved." },
    ]],
    [GAMMA, [
      { revid: 300, timestamp: '2019-01-01T00:00:00Z', text: "'''Gamma''' never changes." },
    ]],
  ]);
}

export function fixtureEntries() {
  return [
    { title: 'Alpha', pageId: ALPHA, domain: 'Physics' },
    { title: 'Beta (old name)', canonical: 'Beta', pageId: BETA, domain: 'Chemistry', status: 'redirect' },
    { title: 'Gamma', pageId: GAMMA, domain: 'Biology' },
    { title: 'Alpha again', canonical: 'Alpha', pageId: ALPHA, domain: 'Physics', status: 'duplicate', duplicateOf: 'Alpha', reason: 'resolves to the same page as "Alpha"' },
    { title: 'Nonexistent thing', domain: 'Biology', status: 'missing', reason: 'page_does_not_exist' },
    { title: 'Mercury', canonical: 'Mercury', domain: 'Astronomy', status: 'disambiguation', pageId: 9999, reason: 'page_is_a_disambiguation_page' },
  ];
}

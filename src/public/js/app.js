// Progressive enhancement only: every page works without JavaScript.
(function () {
  // Article list: search + domain filter (client-side; the list is small).
  const list = document.getElementById('article-list');
  if (list) {
    const search = document.getElementById('article-search');
    const domain = document.getElementById('domain-filter');
    const count = document.getElementById('article-count');
    const items = Array.from(list.children);
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      const d = domain.value;
      let shown = 0;
      for (const li of items) {
        const ok = (!q || li.dataset.title.includes(q)) && (!d || li.dataset.domain === d);
        li.hidden = !ok;
        if (ok) shown++;
      }
      count.textContent = `${shown} of ${items.length}`;
      try { sessionStorage.setItem('wtm-filter', JSON.stringify({ q: search.value, d })); } catch (e) { /* storage unavailable */ }
    };
    try {
      const saved = JSON.parse(sessionStorage.getItem('wtm-filter') || 'null');
      if (saved) { search.value = saved.q || ''; domain.value = saved.d || ''; }
    } catch (e) { /* ignore */ }
    search.addEventListener('input', apply);
    domain.addEventListener('change', apply);
    apply();
  }

  // Chart tooltip (data-tip attributes; textContent only, never innerHTML).
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.hidden = true;
  document.body.appendChild(tip);
  document.querySelectorAll('svg.chart [data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (ev) => {
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      tip.style.left = `${ev.clientX + 12}px`;
      tip.style.top = `${ev.clientY - 28}px`;
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
})();

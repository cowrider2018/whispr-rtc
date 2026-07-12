// Turns range inputs into a left-filling "water level" bar (no thumb) and
// wraps each one so the pressed-state glow can be confined to the filled
// portion. Self-contained: reads only each input's own min/max/value and
// writes the --fill CSS variable (on the wrapper) that the stylesheet uses.
(() => {
  const paint = (el) => {
    const min = Number(el.min) || 0;
    const max = Number(el.max);
    const range = (Number.isFinite(max) ? max : 100) - min;
    const pct = range ? ((Number(el.value) - min) / range) * 100 : 0;
    const target = el.closest('.range-wrap') || el;
    target.style.setProperty('--fill', `${Math.min(Math.max(pct, 0), 100)}%`);
  };

  const enhance = (el) => {
    if (el.closest('.range-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'range-wrap';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    const glow = document.createElement('span');
    glow.className = 'range-glow';
    wrap.appendChild(glow);
    paint(el);
    el.addEventListener('input', () => paint(el));
  };

  const all = () =>
    document.querySelectorAll('input[type="range"]').forEach(paint);

  document.querySelectorAll('input[type="range"]').forEach(enhance);
  // Repaint after modules run (main.js loadSettings sets values programmatically
  // without firing 'input').
  window.addEventListener('load', all);
})();

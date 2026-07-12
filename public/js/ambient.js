// Ambient visual layer — self-contained, no dependency on call logic.
// Renders slow-drifting bokeh "bar lights" behind the UI (midnight jazz-bar
// mood), with a gentle pointer parallax. Safe to remove: nothing imports here.
(() => {
  const canvas = document.getElementById('ambient');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cool blues with the occasional warm amber (whiskey glow across the room).
  const PALETTE = [
    'rgba(70, 120, 200, ',
    'rgba(90, 150, 230, ',
    'rgba(50, 90, 160, ',
    'rgba(120, 175, 240, ',
    'rgba(224, 164, 88, ', // amber — used sparingly
  ];

  let w = 0, h = 0, dpr = 1;
  let lights = [];
  // Pointer, normalized to [-1, 1] from centre, eased for a calm parallax.
  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const count = Math.round(Math.min(Math.max((w * h) / 26000, 14), 40));
    lights = Array.from({ length: count }, () => {
      const amber = Math.random() < 0.14;
      const tint = amber ? PALETTE[4] : PALETTE[(Math.random() * 4) | 0];
      const r = 40 + Math.random() * 130;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r,
        tint,
        depth: 0.3 + Math.random() * 0.9, // parallax strength
        vx: (Math.random() - 0.5) * 0.12,
        vy: -0.05 - Math.random() * 0.14, // drift gently upward
        base: amber ? 0.14 : 0.20,
        phase: Math.random() * Math.PI * 2,
        tw: 0.4 + Math.random() * 0.8, // twinkle speed
      };
    });
  }

  function draw(t) {
    ptr.x += (ptr.tx - ptr.x) * 0.05;
    ptr.y += (ptr.ty - ptr.y) * 0.05;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    for (const l of lights) {
      if (!reduce) {
        l.x += l.vx;
        l.y += l.vy;
        // Wrap around edges with a soft margin so lights re-enter.
        const m = l.r;
        if (l.y < -m) { l.y = h + m; l.x = Math.random() * w; }
        if (l.x < -m) l.x = w + m;
        if (l.x > w + m) l.x = -m;
      }
      const px = l.x + ptr.x * 28 * l.depth;
      const py = l.y + ptr.y * 28 * l.depth;
      const twinkle = reduce ? 1 : 0.75 + 0.25 * Math.sin(t * 0.001 * l.tw + l.phase);
      const alpha = l.base * twinkle;

      const g = ctx.createRadialGradient(px, py, 0, px, py, l.r);
      g.addColorStop(0, l.tint + alpha + ')');
      g.addColorStop(1, l.tint + '0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, l.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (!reduce) requestAnimationFrame(draw);
  }

  // Gentle background parallax that follows the pointer.
  function pointer(e) {
    ptr.tx = (e.clientX / window.innerWidth) * 2 - 1;
    ptr.ty = (e.clientY / window.innerHeight) * 2 - 1;
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', pointer, { passive: true });
  resize();
  requestAnimationFrame(draw);
})();

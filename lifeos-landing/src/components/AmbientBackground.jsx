import { useEffect, useRef } from 'react';

/**
 * Light-weight ambient background:
 *  - CSS animated mesh blobs (free)
 *  - One canvas particle field that subtly tracks the cursor
 * Only transform/opacity changes — GPU-friendly.
 */
export default function AmbientBackground() {
  const canvasRef = useRef(null);
  const pointer = useRef({ x: 0.5, y: 0.5 });
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const PARTICLE_COUNT = window.innerWidth < 640 ? 28 : 56;
    const particles = [];

    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const seed = () => {
      particles.length = 0;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.15,
          vy: (Math.random() - 0.5) * 0.15,
          r: Math.random() * 1.4 + 0.4,
          hue: Math.random() < 0.5 ? '#a5b4fc' : '#c4b5fd',
        });
      }
    };

    resize();
    seed();

    const onResize = () => {
      resize();
      seed();
    };
    window.addEventListener('resize', onResize);

    const onMove = (e) => {
      pointer.current.x = e.clientX / window.innerWidth;
      pointer.current.y = e.clientY / window.innerHeight;
    };
    window.addEventListener('pointermove', onMove);

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      const px = pointer.current.x * width;
      const py = pointer.current.y * height;

      // Connect nearby particles
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Drift + soft attraction toward pointer
        const dx = px - p.x;
        const dy = py - p.y;
        const d2 = dx * dx + dy * dy;
        const pull = Math.min(0.00004, 8 / (d2 + 1));
        p.vx += dx * pull;
        p.vy += dy * pull;

        // Damping
        p.vx *= 0.985;
        p.vy *= 0.985;

        p.x += p.vx;
        p.y += p.vy;

        // Wrap
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        if (p.y > height + 10) p.y = -10;

        // Particle dot
        ctx.beginPath();
        ctx.fillStyle = p.hue;
        ctx.globalAlpha = 0.55;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();

        // Lines to neighbors
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const ddx = p.x - q.x;
          const ddy = p.y - q.y;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 < 130 * 130) {
            const a = 1 - Math.sqrt(dist2) / 130;
            ctx.globalAlpha = a * 0.18;
            ctx.strokeStyle = '#8b5cf6';
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="mesh" />
      <div className="mesh-cyan" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Soft vignette so content stays readable */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(10,10,15,0.85)_85%)]" />
    </div>
  );
}

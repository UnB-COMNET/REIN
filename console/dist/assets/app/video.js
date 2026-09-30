/* Simulated DASH playback for clients whose image plays video. The frame is rendered at the
   current rendition's resolution, so a drop from 2160p to 720p is visible as softness; a stall
   freezes the frame. The label is burned in, like the lft-dash-video server does. Replace with
   dash.js pointing at /video/<client>/manifest.mpd. */
(() => {
  'use strict';
  const R = window.REIN;
  const poster = new Image();
  poster.src = 'assets/img/player-poster-1280.webp';
  // Share of the canvas resolution each rendition keeps: 1080p and up look sharp at this size
  const scaleOf = { '2160p': 1, '1440p': 1, '1080p': 1, '720p': .62, '480p': .38, '360p': .26, '240p': .16 };
  const players = new Set();

  R.video = {
    mount(canvas, clientId) {
      const ctx = canvas.getContext('2d');
      const off = document.createElement('canvas');
      const octx = off.getContext('2d');
      const p = { canvas, clientId, t0: performance.now(), frozenAt: null, lastRes: null, blurUntil: 0, visible: true };
      const io = new IntersectionObserver(([e]) => { p.visible = e.isIntersecting; });
      io.observe(canvas);
      p.draw = now => {
        const W = canvas.width = canvas.clientWidth * devicePixelRatio || 640;
        const H = canvas.height = canvas.clientHeight * devicePixelRatio || 360;
        const q = R.qoe(p.clientId);
        if (!poster.complete || !W) return;
        if (q.res !== p.lastRes) { if (p.lastRes) p.blurUntil = now + 450; p.lastRes = q.res; }
        if (q.stalled) { p.frozenAt ??= now; } else if (p.frozenAt) { p.t0 += now - p.frozenAt; p.frozenAt = null; }
        const t = Math.max(0, ((p.frozenAt ?? now) - p.t0) / 1000);
        const s = scaleOf[q.res] ?? 1;
        const ow = Math.max(24, Math.round(W * s)), oh = Math.max(14, Math.round(H * s));
        off.width = ow; off.height = oh;
        const pan = R.reduced.matches ? 0 : (Math.sin(t / 9) + 1) / 2;
        const zoom = 1.12 + (R.reduced.matches ? 0 : Math.sin(t / 13) * .03);
        const sw = poster.width / zoom, sh = poster.height / zoom;
        octx.imageSmoothingEnabled = true;
        octx.drawImage(poster, (poster.width - sw) * pan, (poster.height - sh) * .45, sw, sh, 0, 0, ow, oh);
        ctx.imageSmoothingEnabled = s >= .5;
        ctx.filter = now < p.blurUntil ? 'blur(6px)' : q.stalled ? 'grayscale(1) brightness(.45)' : 'none';
        ctx.drawImage(off, 0, 0, W, H);
        ctx.filter = 'none';
        const u = W / 640;
        ctx.font = `600 ${13 * u}px Inter, sans-serif`;
        const label = q.stalled ? 'Sem segmentos' : `${q.res} ${R.fmt(q.bitrate)} Mbps`;
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.beginPath(); ctx.roundRect(12 * u, 12 * u, lw + 16 * u, 24 * u, 6 * u); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, 20 * u, 29 * u);
        const mm = String(Math.floor(t / 60)).padStart(2, '0'), ss = String(Math.floor(t % 60)).padStart(2, '0');
        ctx.font = `500 ${12 * u}px "Plex Mono", monospace`;
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.fillText(`${mm}:${ss}`, 14 * u, H - 14 * u);
        const bw = W - 28 * u, by = H - 8 * u;
        ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(14 * u, by, bw, 2 * u);
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(14 * u, by, bw * ((t % 360) / 360), 2 * u);
        if (q.stalled) {
          const cx = W / 2, cy = H / 2, r = 16 * u, a = (now / 160) % (Math.PI * 2);
          ctx.lineWidth = 3 * u; ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r, a, a + 1.4); ctx.stroke();
          ctx.font = `500 ${13 * u}px Inter, sans-serif`; ctx.textAlign = 'center';
          ctx.fillText('Rebuffering', cx, cy + r + 22 * u); ctx.textAlign = 'start';
        }
      };
      players.add(p);
      return () => { players.delete(p); io.disconnect(); };
    },
  };

  const loop = now => {
    players.forEach(p => { if (p.visible && p.canvas.isConnected) p.draw(now); });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();

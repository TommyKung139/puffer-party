// Draws a pufferfish. It puffs up with every strike and floats belly-up when out.
export function pufferSVG({ color = '#ffd23f', strikes = 0, out = false } = {}) {
  const s = out ? 0 : Math.max(0, Math.min(strikes, 2));
  const r = out ? 26 : 26 + s * 6;
  const spikeLen = out ? 3 : 4 + s * 5;
  const body = out ? '#8a94a6' : color;
  const pt = (a, d) => `${(Math.cos(a) * d).toFixed(1)},${(Math.sin(a) * d).toFixed(1)}`;

  let spikes = '';
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (Math.abs(a - Math.PI) < 0.45) continue; // room for the tail
    spikes += `<polygon points="${pt(a - 0.13, r - 2)} ${pt(a, r + spikeLen)} ${pt(a + 0.13, r - 2)}"/>`;
  }

  const ex = r * 0.4, ey = -r * 0.22, er = Math.max(6, r * 0.22);
  const ink = '#14213d';
  const eye = out
    ? `<g stroke="${ink}" stroke-width="3.2" stroke-linecap="round">
         <line x1="${ex - er * 0.6}" y1="${ey - er * 0.6}" x2="${ex + er * 0.6}" y2="${ey + er * 0.6}"/>
         <line x1="${ex + er * 0.6}" y1="${ey - er * 0.6}" x2="${ex - er * 0.6}" y2="${ey + er * 0.6}"/></g>`
    : `<circle cx="${ex}" cy="${ey}" r="${er}" fill="#fff"/>
       <circle cx="${ex + er * 0.3}" cy="${ey + (s >= 2 ? er * 0.15 : 0)}" r="${er * (s >= 2 ? 0.35 : 0.5)}" fill="${ink}"/>
       <circle cx="${ex + er * 0.45}" cy="${ey - er * 0.28}" r="${er * 0.17}" fill="#fff"/>`;
  const mouth = !out && s >= 1
    ? `<ellipse cx="${r * 0.9}" cy="${r * 0.2}" rx="${2 + s}" ry="${3 + s}" fill="${ink}"/>`
    : `<path d="M ${r * 0.74} ${r * 0.18} q 5 5 10 0" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  const sweat = !out && s >= 2
    ? `<path d="M ${-r * 0.2} ${-r - 2} q -5 8 0 11 q 5 -3 0 -11" fill="#9be7ff" stroke="${ink}" stroke-width="1.5"/>`
    : '';

  return `<svg class="puffer${out ? ' is-out' : ''}" viewBox="-56 -56 112 112" aria-hidden="true">
  <g${out ? ' transform="rotate(180)"' : ''}>
    <path d="M ${-r + 6} 0 L ${-r - 14} -14 Q ${-r - 8} 0 ${-r - 14} 14 Z" fill="${body}" stroke="rgba(0,0,0,.3)" stroke-width="2" stroke-linejoin="round"/>
    <g fill="${body}" stroke="rgba(0,0,0,.3)" stroke-width="1.6" stroke-linejoin="round">${spikes}</g>
    <circle r="${r}" fill="${body}" stroke="rgba(0,0,0,.3)" stroke-width="2"/>
    <ellipse cx="0" cy="${r * 0.45}" rx="${r * 0.72}" ry="${r * 0.38}" fill="#fff" opacity=".38"/>
    <path d="M ${-r * 0.05} ${r * 0.05} q ${-r * 0.35} ${r * 0.05} ${-r * 0.3} ${r * 0.38}" stroke="rgba(0,0,0,.28)" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    ${eye}${mouth}${sweat}
  </g>
</svg>`;
}

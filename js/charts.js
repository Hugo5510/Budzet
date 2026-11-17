// Proste wykresy SVG (bez bibliotek, działają offline).
import { fmt, esc } from './util.js';

export function donut(segs, centerTop = '', centerBottom = '') {
  const R = 68, C = 2 * Math.PI * R, SW = 13;
  const total = segs.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const gap = segs.length > 1 ? 2.5 : 0;
  const rings = total
    ? segs
        .map((s) => {
          const len = (s.value / total) * C;
          const vis = Math.max(len - gap, 0.6);
          const c = `<circle r="${R}" cx="80" cy="80" fill="none" stroke="${esc(s.color)}" stroke-width="${SW}"
            stroke-dasharray="${vis} ${C - vis}" stroke-dashoffset="${-acc}" transform="rotate(-90 80 80)"/>`;
          acc += len;
          return c;
        })
        .join('')
    : `<circle r="${R}" cx="80" cy="80" fill="none" stroke="var(--line)" stroke-width="${SW}"/>`;
  return `<svg class="donut" viewBox="0 0 160 160" role="img" aria-label="Wykres kołowy wydatków">
    ${rings}
    <text x="80" y="79" text-anchor="middle" class="donut-top">${esc(centerTop)}</text>
    <text x="80" y="97" text-anchor="middle" class="donut-bottom">${esc(centerBottom)}</text>
  </svg>`;
}

export function bars(values, labels, { highlight = -1 } = {}) {
  const W = 340, H = 150, top = 14, bottom = 20;
  const n = values.length;
  const max = Math.max(...values, 1);
  const step = W / n;
  const bw = Math.max(Math.min(step * 0.6, 22), 2);
  const ch = H - top - bottom;
  const rects = values
    .map((v, i) => {
      const h = v ? Math.max((v / max) * ch, 2) : 0;
      const x = i * step + (step - bw) / 2;
      const y = top + ch - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(5, bw / 2)}"
        class="bar ${i === highlight ? 'hi' : ''}"><title>${esc(labels[i] || '')}: ${fmt(v)}</title></rect>`;
    })
    .join('');
  const lbls = labels
    .map((l, i) => (l ? `<text x="${(i * step + step / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="bar-lbl">${esc(l)}</text>` : ''))
    .join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wykres słupkowy wydatków">
    <line x1="0" x2="${W}" y1="${top}" y2="${top}" class="grid"/>
    <line x1="0" x2="${W}" y1="${top + ch / 2}" y2="${top + ch / 2}" class="grid"/>
    <line x1="0" x2="${W}" y1="${top + ch}" y2="${top + ch}" class="axis"/>
    <text x="2" y="${top - 3}" class="bar-max">${values.some((v) => v) ? esc(fmt(max)) : ''}</text>
    ${rects}${lbls}
  </svg>`;
}

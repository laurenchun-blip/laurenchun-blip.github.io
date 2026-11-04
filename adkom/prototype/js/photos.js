// MOCKED: invented placeholder "photos" for signs, drawn as SVG. No real sign imagery in the prototype.
// Roadside signs get a billboard on a pole; place-based signs get a screen on a store wall.
// Colors are illustration-only (like the color doc's board photo placeholder), seeded from the listing ID.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const AD_PALETTES = [
  ['#1d1e2c', '#e75c4b', '#fbfaf7'],
  ['#00404a', '#69d957', '#ffffff'],
  ['#20498d', '#f8bb61', '#ffffff'],
  ['#5c2a6e', '#fdd399', '#ffffff'],
  ['#145c0f', '#ffffff', '#b6ecb0'],
  ['#891d1f', '#ffffff', '#fecdc8'],
];

export function placeholderPhoto(listing, w = 360, h = 150) {
  const n = hash(listing.id);
  const [bg, accent, ink] = AD_PALETTES[n % AD_PALETTES.length];
  const skyTop = ['#cfe6f2', '#dbe9f5', '#e7eef3', '#f3e3d3'][n % 4];
  if (listing.environment === 'Place based') {
    const portrait = listing.orientation === 'Portrait';
    const sw = portrait ? 54 : 120, sh = portrait ? 96 : 68;
    const sx = w / 2 - sw / 2, sy = 22;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Placeholder photo of an in-store screen">
      <rect width="${w}" height="${h}" fill="#e9e6e1"/>
      <rect y="${h - 34}" width="${w}" height="34" fill="#d8d3cc"/>
      <rect x="18" y="${h - 70}" width="70" height="40" rx="3" fill="#f4f1ec" stroke="#cfc9c1"/>
      <rect x="${w - 92}" y="${h - 74}" width="76" height="44" rx="3" fill="#f4f1ec" stroke="#cfc9c1"/>
      <rect x="${sx - 5}" y="${sy - 5}" width="${sw + 10}" height="${sh + 10}" rx="4" fill="#2c2b29"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="${bg}"/>
      <circle cx="${sx + sw * 0.72}" cy="${sy + sh * 0.35}" r="${Math.min(sw, sh) * 0.22}" fill="${accent}"/>
      <rect x="${sx + 8}" y="${sy + sh - 22}" width="${sw * 0.55}" height="6" rx="2" fill="${ink}"/>
      <rect x="${sx + 8}" y="${sy + sh - 12}" width="${sw * 0.35}" height="4" rx="2" fill="${ink}" opacity=".7"/>
    </svg>`;
  }
  const wide = listing.media === 'Bulletin';
  const bw = wide ? 190 : 120, bh = wide ? 62 : 56;
  const bx = 40 + (n % 5) * 18, by = 20;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Placeholder photo of a roadside billboard">
    <defs><linearGradient id="sky${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="#f6f4ef"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#sky${n})"/>
    <path d="M0 ${h - 40} Q ${w * 0.3} ${h - 52} ${w * 0.55} ${h - 44} T ${w} ${h - 46} V ${h} H 0 Z" fill="#cfd8c8"/>
    <rect y="${h - 22}" width="${w}" height="22" fill="#9b9893"/>
    <rect y="${h - 12}" width="${w}" height="2" fill="#f6f4ef" stroke-dasharray="14 10"/>
    <rect x="${bx + bw / 2 - 4}" y="${by + bh}" width="8" height="${h - 22 - by - bh}" fill="#6b6966"/>
    <rect x="${bx - 4}" y="${by - 4}" width="${bw + 8}" height="${bh + 8}" rx="2" fill="#3a3936"/>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${bg}"/>
    <rect x="${bx + 10}" y="${by + 12}" width="${bw * 0.48}" height="9" rx="2" fill="${ink}"/>
    <rect x="${bx + 10}" y="${by + 27}" width="${bw * 0.34}" height="6" rx="2" fill="${ink}" opacity=".75"/>
    <circle cx="${bx + bw - bh / 2 - 4}" cy="${by + bh / 2}" r="${bh * 0.32}" fill="${accent}"/>
  </svg>`;
}

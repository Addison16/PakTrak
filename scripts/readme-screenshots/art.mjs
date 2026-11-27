// Made-up card faces drawn as SVG, so README screenshots never show real cards.
export const palettes = {
  R: { frame: "#b4492b", sky: ["#f3b06a", "#e07a46"], far: "#c9583a", near: "#5c1f14" },
  U: { frame: "#2e5f8f", sky: ["#9cc8ea", "#5f97c9"], far: "#3d79b0", near: "#1c3858" },
  G: { frame: "#3f6e3a", sky: ["#cfe3a6", "#8fbf6f"], far: "#5d9a4a", near: "#24401f" },
  W: { frame: "#d9cba4", sky: ["#f7e7b4", "#efcf82"], far: "#e3b065", near: "#8a6a3c" },
  B: { frame: "#3b3038", sky: ["#a090a6", "#6d5a72"], far: "#5a465f", near: "#231a25" },
  M: { frame: "#b38b3a", sky: ["#f2d6a0", "#d9a86a"], far: "#a8703f", near: "#4a2f1b" },
  C: { frame: "#8c9196", sky: ["#e2e5e8", "#b9c0c6"], far: "#98a1a9", near: "#3c434a" },
  L: { frame: "#7b6a55", sky: ["#e8dcc5", "#c4ae8c"], far: "#9c8565", near: "#4a3b2a" },
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let seed = 7;
const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);

export function cardSvg({ name, type, set, number, color }, variant = 0) {
  const p = palettes[color] || palettes.C;
  seed = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), variant * 31);
  const ridge = (y, amp) => { let d = `M24 ${y}`; for (let x = 24; x <= 216; x += 24) d += ` L${x} ${y - rand() * amp}`; return d + " L216 186 L24 186 Z"; };
  const sunX = 70 + rand() * 100, sunY = 70 + rand() * 25;
  const uid = name.replace(/\W/g, "") + variant;
  const light = color === "W" || color === "C" ? "#2b2722" : "#2b2722";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 336" width="488" height="680">
<defs><linearGradient id="s${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="240" height="336" rx="13" fill="#161616"/>
<rect x="8" y="8" width="224" height="320" rx="8" fill="${p.frame}"/>
<rect x="16" y="16" width="208" height="22" rx="3" fill="#f1e8d8"/>
<text x="23" y="31.5" font-family="Georgia, serif" font-size="11" font-weight="700" fill="${light}">${esc(name)}</text>
<rect x="22" y="44" width="196" height="146" fill="url(#s${uid})" stroke="#2a2520" stroke-width="1.2"/>
<circle cx="${sunX}" cy="${sunY}" r="20" fill="#fff" opacity=".55"/>
<path d="${ridge(140, 40)}" fill="${p.far}"/>
<path d="${ridge(170, 22)}" fill="${p.near}"/>
<rect x="16" y="194" width="208" height="18" rx="3" fill="#f1e8d8"/>
<text x="22" y="206.5" font-family="Georgia, serif" font-size="7.5" fill="${light}">${esc(type)}</text>
<rect x="22" y="216" width="196" height="92" fill="#f5efe3"/>
<g stroke="#cfc8bb" stroke-width="3" stroke-linecap="round"><path d="M34 232 H206"/><path d="M34 246 H206"/><path d="M34 260 H206"/><path d="M34 274 H140"/></g>
<text x="20" y="320" font-family="Arial, sans-serif" font-size="5" fill="${color === "W" ? "#5a4a2a" : "#e8e0d0"}">${esc(set.toUpperCase())} · ${esc(String(number))} · Sample art</text>
</svg>`;
}

export function artSvg(card) {
  // The art crop alone, used for deck box covers.
  const p = palettes[card.color] || palettes.C;
  seed = [...card.name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const ridge = (y, amp) => { let d = `M0 ${y}`; for (let x = 0; x <= 320; x += 32) d += ` L${x} ${y - rand() * amp}`; return d + " L320 234 L0 234 Z"; };
  const uid = card.name.replace(/\W/g, "");
  const sunX = 80 + rand() * 160, sunY = 70 + rand() * 30;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 234" width="640" height="468">
<defs><linearGradient id="s${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="320" height="234" fill="url(#s${uid})"/><circle cx="${sunX}" cy="${sunY}" r="28" fill="#fff" opacity=".55"/>
<path d="${ridge(170, 55)}" fill="${p.far}"/><path d="${ridge(210, 30)}" fill="${p.near}"/></svg>`;
}

// A binder page photo: nine cards in sleeves, slightly tilted, on a dark page.
export function binderPhoto(pageCards) {
  const W = 1200, H = 1600, cw = 340, ch = 476, gx = 40, gy = 40;
  const left = (W - 3 * cw - 2 * gx) / 2, top = (H - 3 * ch - 2 * gy) / 2;
  const regions = [];
  const parts = pageCards.map((card, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = left + col * (cw + gx), y = top + row * (ch + gy);
    const angle = [-1.2, 0.6, -0.4, 0.9, -0.7, 0.3, 1.1, -0.9, 0.5][i] || 0;
    const cx = x + cw / 2, cy = y + ch / 2, r = angle * Math.PI / 180;
    const corner = (dx, dy) => [Math.round((cx + dx * Math.cos(r) - dy * Math.sin(r)) / W * 10000) / 10000, Math.round((cy + dx * Math.sin(r) + dy * Math.cos(r)) / H * 10000) / 10000];
    regions.push([corner(-cw / 2, -ch / 2), corner(cw / 2, -ch / 2), corner(cw / 2, ch / 2), corner(-cw / 2, ch / 2)]);
    const inner = cardSvg(card).replace(/<svg[^>]*>/, `<svg x="${x}" y="${y}" width="${cw}" height="${ch}" viewBox="0 0 240 336">`);
    return `<g transform="rotate(${angle} ${cx} ${cy})"><rect x="${x - 10}" y="${y - 10}" width="${cw + 20}" height="${ch + 20}" rx="10" fill="#ffffff" opacity=".08"/>${inner}<rect x="${x}" y="${y}" width="${cw}" height="${ch * 0.45}" rx="14" fill="url(#glare)"/></g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs><radialGradient id="bg" cx=".45" cy=".35" r=".9"><stop offset="0" stop-color="#3a3d42"/><stop offset="1" stop-color="#1b1d20"/></radialGradient>
<linearGradient id="glare" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${parts.join("")}</svg>`;
  return { svg, regions, width: W, height: H };
}

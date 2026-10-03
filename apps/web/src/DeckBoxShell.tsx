import { useId, useLayoutEffect, useRef, useState } from "react";

// The front is 74% of a 1:1.31 shelf slot, with 78% of its height.
// These proportions also define --deck-unit and the case inset in CSS.
const height = 100 * 1.31 * .78 / .74;
const wall = 3;
const lidBottom = 3;
const across = .32;
const rise = .14;
type Point = { x: number; y: number; z: number };
type Face = { name: string; points: Point[]; normal: Point; finish: string };
const point = (x: number, y: number, z: number): Point => ({ x, y, z });
const project = ({ x, y, z }: Point) => ({ x: x + z * across, y: y - z * rise });
const path = (points: Point[]) => points.map((value, index) => {
  const p = project(value);
  return `${index ? "L" : "M"}${p.x.toFixed(3)},${p.y.toFixed(3)}`;
}).join(" ") + " Z";
const depthOrder = (points: Point[]) => points.reduce((sum, p) => sum + p.x * across - p.y * rise - p.z, 0) / points.length;
const facing = (normal: Point) => normal.x * across - normal.y * rise - normal.z > .001;
const atHeight = (points: Point[], y: number) => points.map(p => point(p.x, y, p.z));
const ring = (x0: number, x1: number, z0: number, z1: number, bevel: number): Point[] => [
  point(x0 + bevel, 0, z0), point(x1 - bevel, 0, z0),
  point(x1, 0, z0 + bevel), point(x1, 0, z1 - bevel),
  point(x1 - bevel, 0, z1), point(x0 + bevel, 0, z1),
  point(x0, 0, z1 - bevel), point(x0, 0, z0 + bevel),
];
const names = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"];
const edgeNormal = (a: Point, b: Point) => point(b.z - a.z, 0, a.x - b.x);
const joinedFaces = (upper: Point[], top: number, lower: Point[], bottom: number): Face[] => upper.map((a, index) => {
  const next = (index + 1) % upper.length;
  const b = upper[next], c = lower[next], d = lower[index];
  const down = point(d.x - a.x, bottom - top, d.z - a.z);
  const along = point(b.x - a.x, 0, b.z - a.z);
  const normal = point(down.y * along.z, down.z * along.x - down.x * along.z, -down.y * along.x);
  return { name: names[index], points: [point(a.x, top, a.z), point(b.x, top, b.z), point(c.x, bottom, c.z), point(d.x, bottom, d.z)], normal, finish: index % 2 ? "bevel" : index === 0 ? "front" : "side" };
});
const edgeFaces = (outline: Point[], top: number, bottom: number) => joinedFaces(outline, top, outline, bottom);
const rimFaces = (outside: Point[], inside: Point[], y: number): Face[] => outside.map((a, index) => {
  const next = (index + 1) % outside.length;
  return { name: `${names[index]}-rim`, points: atHeight([a, outside[next], inside[next], inside[index]], y), normal: point(0, 1, 0), finish: "rim" };
});

function bodyProfile(depth: number) {
  const outside = ring(-wall, 100 + wall, 0, depth, wall);
  return [
    { y: 0, outline: outside },
    { y: height - 3, outline: outside },
    { y: height - 1.2, outline: ring(-2.4, 102.4, .6, depth - .6, 2.8) },
    { y: height, outline: ring(-1.4, 101.4, 1.6, depth - 1.6, 2.4) },
  ];
}

// The artwork, grain and pointer light follow the same front silhouette as
// the solid mesh. Both case depths share these front vertices.
const frontProfile = bodyProfile(72);
export const deckBoxFrontClip = "polygon(" + [
  ...frontProfile.map(level => point(level.outline[1].x, level.y, level.outline[1].z)),
  ...[...frontProfile].reverse().map(level => point(level.outline[0].x, level.y, level.outline[0].z)),
].map(p => { const value = project(p); return `${value.x.toFixed(4)}% ${(value.y / height * 100).toFixed(4)}%`; }).join(", ") + ")";

// Shared projected vertices keep the enclosure intact in WebKit as well as
// Chromium. The foreground copy includes only the walls nearest the viewer.
export function DeckBoxShell({ commander, foreground = false }: { commander: boolean; foreground?: boolean }) {
  const id = useId().replace(/:/g, "");
  const depth = commander ? 72 : 54;
  const profile = bodyProfile(depth);
  const outside = profile[0].outline;
  const inside = ring(0, 100, wall, depth - wall, 1.5);
  const walls = profile.slice(1).flatMap((level, index) => joinedFaces(profile[index].outline, profile[index].y, level.outline, level.y).map(face => ({
    ...face, name: index ? `base-${index}-${face.name}` : face.name, finish: index ? `base-${face.finish}` : face.finish,
  }))).filter(face => facing(face.normal));
  const innerWalls = edgeFaces(inside, 0, 24).filter(face => !facing(face.normal));
  const rims = rimFaces(outside, inside, 0).filter((_, index) => !foreground || facing(edgeNormal(outside[index], outside[(index + 1) % outside.length])));
  return <>
    <svg className="deck-box-body" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-front`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2={height}><stop stopColor="color-mix(in srgb, var(--deck-paint) 96%, #a3aea8)" /><stop offset=".5" stopColor="var(--deck-paint)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 94%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-side`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 88%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 74%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-bevel`} gradientUnits="userSpaceOnUse" x2="0" y2={height}><stop stopColor="color-mix(in srgb, var(--deck-paint) 94%, #a3aea8)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 97%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-base-front`} gradientUnits="userSpaceOnUse" x1="0" y1={height - 3} x2="0" y2={height}><stop stopColor="color-mix(in srgb, var(--deck-paint) 94%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 90%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-base-side`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 80%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 76%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-base-bevel`} gradientUnits="userSpaceOnUse" x1="0" y1={height - 3} x2="0" y2={height}><stop stopColor="color-mix(in srgb, var(--deck-paint) 97%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 92%, #080e12)" /></linearGradient>
        <linearGradient id={`${id}-well`} x2="0" y2="1"><stop stopColor="#05080b" /><stop offset="1" stopColor="#1b272b" /></linearGradient>
        <clipPath id={`${id}-opening`}><path d={path(inside)} /></clipPath>
      </defs>
      {walls.map(face => <path key={face.name} className={`deck-box-shell-${face.name}`} d={path(face.points)} fill={`url(#${id}-${face.finish})`} stroke={`url(#${id}-${face.finish})`} strokeWidth=".6" strokeLinejoin="round" />)}
      {!foreground && <g clipPath={`url(#${id}-opening)`}>
        <path className="deck-box-well" d={path(outside)} fill={`url(#${id}-well)`} />
        {innerWalls.map(face => <path key={face.name} className={`deck-box-inner-wall deck-box-inner-${face.name}`} d={path(face.points)} stroke="#172126" strokeWidth=".5" />)}
      </g>}
    </svg>
    <svg className="deck-box-mouth" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {rims.map(face => <path key={face.name} className="deck-box-rim" d={path(face.points)} />)}
      {!foreground && <>
        <path className="deck-box-rim-edge" d={path(inside)} />
        {[18, 68].map(x => <path key={x} className="deck-box-hinge" d={path([point(x, .5, depth), point(x + 14, .5, depth), point(x + 14, 3, depth), point(x, 3, depth)])} />)}
      </>}
      <path className="deck-box-front-edge" d={path([point(0, 0, 0), point(100, 0, 0), point(100, 1.5, 0), point(0, 1.5, 0)])} />
      <path className="deck-box-finger-notch" d="M43,1.5 H57 Q56.4,4 54.5,4 H45.5 Q43.6,4 43,1.5 Z" />
    </svg>
  </>;
}

function capFaces(depth: number): Face[] {
  const outside = ring(-3.8, 103.8, -.8, depth + .8, 3.8);
  const crown = ring(-3.1, 103.1, -.1, depth + .1, 3.1);
  // Keep the rear lower edge on the hinge axis as the leading edge softens.
  const lower = ring(-3.55, 103.55, -.55, depth + .8, 3.55);
  const inside = ring(-.8, 100.8, 2.2, depth - 2.2, 1.7);
  const top = -4, ceiling = -1.7;
  return [
    { name: "top", points: atHeight(crown, top), normal: point(0, -1, 0), finish: "top" },
    ...joinedFaces(crown, top, outside, top + .8).map(face => ({ ...face, name: `crown-${face.name}`, finish: "crown" })),
    ...edgeFaces(outside, top + .8, lidBottom - .45),
    ...joinedFaces(outside, lidBottom - .45, lower, lidBottom).map(face => ({ ...face, name: `lower-${face.name}`, finish: "lower" })),
    { name: "lining", points: atHeight(inside, ceiling), normal: point(0, 1, 0), finish: "lining" },
    ...edgeFaces(inside, ceiling, lidBottom).map(face => ({ ...face, name: `inner-${face.name}`, normal: point(-face.normal.x, 0, -face.normal.z), finish: "inner" })),
    ...rimFaces(lower, inside, lidBottom),
  ];
}

export function DeckBoxLid({ commander, opening }: { commander: boolean; opening: boolean }) {
  const id = useId().replace(/:/g, "");
  const element = useRef<SVGSVGElement>(null);
  const [angle, setAngle] = useState(0);
  const depth = commander ? 72 : 54;
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const hinge = depth + .8;
  const rotate = ({ x, y, z }: Point): Point => ({ x, y: lidBottom + (y - lidBottom) * cosine + (z - hinge) * sine, z: hinge + (z - hinge) * cosine - (y - lidBottom) * sine });
  const normal = ({ x, y, z }: Point): Point => ({ x, y: y * cosine + z * sine, z: z * cosine - y * sine });
  const faces = capFaces(depth).filter(face => facing(normal(face.normal))).map(face => ({ ...face, points: face.points.map(rotate) })).sort((a, b) => depthOrder(a.points) - depthOrder(b.points));

  useLayoutEffect(() => {
    if (!opening || !element.current) return;
    // A browser animation supplies the clock so pause/finish also controls
    // the hinge. At rest there is no animation loop for shelf boxes.
    const animation = element.current.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 620, delay: 110, easing: "cubic-bezier(.25, .1, .25, 1)", fill: "both" });
    animation.id = "deck-lid-hinge";
    let frame = 0, previous = -1;
    const paint = () => {
      const progress = animation.effect?.getComputedTiming().progress || 0;
      const next = progress * 112;
      if (next !== previous) { previous = next; setAngle(next); }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => { cancelAnimationFrame(frame); animation.cancel(); };
  }, [opening]);

  return <svg ref={element} className="deck-box-lid" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" data-hinge-angle={angle.toFixed(2)} aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-top`} x2=".5" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 93%, #a3aea8)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 97%, #a3aea8)" /></linearGradient>
      <linearGradient id={`${id}-crown`} x2="0" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 90%, #a3aea8)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 96%, #a3aea8)" /></linearGradient>
      <linearGradient id={`${id}-front`} x2=".2" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 97%, #a3aea8)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 97%, #080e12)" /></linearGradient>
      <linearGradient id={`${id}-side`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 88%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 74%, #080e12)" /></linearGradient>
      <linearGradient id={`${id}-bevel`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 94%, #a3aea8)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
      <linearGradient id={`${id}-lower`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 87%, #080e12)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 76%, #080e12)" /></linearGradient>
      <linearGradient id={`${id}-lining`} x2="0" y2="1"><stop stopColor="#1b272a" /><stop offset="1" stopColor="#0a1014" /></linearGradient>
      <linearGradient id={`${id}-inner`} x2="0" y2="1"><stop stopColor="#080d10" /><stop offset="1" stopColor="#293438" /></linearGradient>
      <linearGradient id={`${id}-rim`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 80%, var(--deck-trim))" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
    </defs>
    {faces.map(face => <path key={face.name} className={`deck-box-cap-face deck-box-cap-${face.name}`} d={path(face.points)} fill={`url(#${id}-${face.finish})`} stroke={`url(#${id}-${face.finish})`} strokeWidth="1" strokeLinejoin="round" />)}
  </svg>;
}

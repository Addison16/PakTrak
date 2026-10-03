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
const edgeFaces = (outline: Point[], top: number, bottom: number): Face[] => outline.map((a, index) => {
  const b = outline[(index + 1) % outline.length];
  return { name: names[index], points: [point(a.x, top, a.z), point(b.x, top, b.z), point(b.x, bottom, b.z), point(a.x, bottom, a.z)], normal: edgeNormal(a, b), finish: index % 2 ? "bevel" : index === 0 ? "front" : "side" };
});
const rimFaces = (outside: Point[], inside: Point[], y: number): Face[] => outside.map((a, index) => {
  const next = (index + 1) % outside.length;
  return { name: `${names[index]}-rim`, points: atHeight([a, outside[next], inside[next], inside[index]], y), normal: point(0, 1, 0), finish: "rim" };
});

// Shared projected vertices keep the enclosure intact in WebKit as well as
// Chromium. The foreground copy includes only the walls nearest the viewer.
export function DeckBoxShell({ commander, foreground = false }: { commander: boolean; foreground?: boolean }) {
  const id = useId().replace(/:/g, "");
  const depth = commander ? 72 : 54;
  const outside = ring(-wall, 100 + wall, 0, depth, wall);
  const inside = ring(0, 100, wall, depth - wall, 1.5);
  const walls = edgeFaces(outside, 0, height).filter(face => facing(face.normal));
  const innerWalls = edgeFaces(inside, 0, 24).filter(face => !facing(face.normal));
  const rims = rimFaces(outside, inside, 0).filter((_, index) => !foreground || facing(edgeNormal(outside[index], outside[(index + 1) % outside.length])));
  return <>
    <svg className="deck-box-body" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-side`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 84%, #05090c)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 60%, #05090c)" /></linearGradient>
        <linearGradient id={`${id}-bevel`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 88%, #b3b9b5)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
        <linearGradient id={`${id}-well`} x2="0" y2="1"><stop stopColor="#05080b" /><stop offset="1" stopColor="#1b272b" /></linearGradient>
        <clipPath id={`${id}-opening`}><path d={path(inside)} /></clipPath>
      </defs>
      {walls.map(face => <path key={face.name} className={`deck-box-shell-${face.name}`} d={path(face.points)} fill={face.finish === "front" ? "var(--deck-paint)" : `url(#${id}-${face.finish})`} stroke="var(--deck-paint)" strokeWidth=".6" strokeLinejoin="round" />)}
      {edgeFaces(outside, height - 3, height).filter(face => facing(face.normal)).map(face => <path key={`heel-${face.name}`} className="deck-box-heel" d={path(face.points)} />)}
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
      <path className="deck-box-finger-notch" d={path([point(43, 1.5, 0), point(57, 1.5, 0), point(56, 3.5, 0), point(44, 3.5, 0)])} />
    </svg>
  </>;
}

function capFaces(depth: number): Face[] {
  const outside = ring(-3.8, 103.8, -.8, depth + .8, 3.8);
  const inside = ring(-.8, 100.8, 2.2, depth - 2.2, 1.7);
  const top = -4, ceiling = -1.7;
  return [
    { name: "top", points: atHeight(outside, top), normal: point(0, -1, 0), finish: "top" },
    ...edgeFaces(outside, top, lidBottom),
    { name: "lining", points: atHeight(inside, ceiling), normal: point(0, 1, 0), finish: "lining" },
    ...edgeFaces(inside, ceiling, lidBottom).map(face => ({ ...face, name: `inner-${face.name}`, normal: point(-face.normal.x, 0, -face.normal.z), finish: "inner" })),
    ...rimFaces(outside, inside, lidBottom),
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
      <linearGradient id={`${id}-top`} x2=".5" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 86%, #afb9b3)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
      <linearGradient id={`${id}-front`} x2=".2" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 94%, #aab3ad)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
      <linearGradient id={`${id}-side`}><stop stopColor="var(--deck-paint)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 62%, #080b0d)" /></linearGradient>
      <linearGradient id={`${id}-bevel`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 88%, #b3b9b5)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
      <linearGradient id={`${id}-lining`} x2="0" y2="1"><stop stopColor="#1b272a" /><stop offset="1" stopColor="#0a1014" /></linearGradient>
      <linearGradient id={`${id}-inner`} x2="0" y2="1"><stop stopColor="#080d10" /><stop offset="1" stopColor="#293438" /></linearGradient>
      <linearGradient id={`${id}-rim`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 80%, var(--deck-trim))" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
    </defs>
    {faces.map(face => <path key={face.name} className={`deck-box-cap-face deck-box-cap-${face.name}`} d={path(face.points)} fill={`url(#${id}-${face.finish})`} stroke={`url(#${id}-${face.finish})`} strokeWidth=".9" strokeLinejoin="round" />)}
  </svg>;
}

import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { DeckEmblem, type CaseEmblem } from "./deckPresentation";

const height = 164.53125;
const wall = 5;
const lidBottom = 26;
const across = .55;
const rise = .28;
type Point = { x: number; y: number; z: number };
type Face = { name: string; points: Point[]; normal: Point; finish: string };
const point = (x: number, y: number, z: number): Point => ({ x, y, z });
const project = ({ x, y, z }: Point) => ({ x: x + z * across, y: y - z * rise });
const path = (points: Point[]) => points.map((value, index) => {
  const p = project(value);
  return `${index ? "L" : "M"}${p.x.toFixed(3)},${p.y.toFixed(3)}`;
}).join(" ") + " Z";
const depthOrder = (points: Point[]) => points.reduce((sum, p) => sum + p.x * across - p.y * rise - p.z, 0) / points.length;

// Use shared projected vertices for solid faces, instead of independent 3D
// layers whose edges can separate or disappear in WebKit.
export function DeckBoxShell({ commander, foreground = false }: { commander: boolean; foreground?: boolean }) {
  const id = useId().replace(/:/g, "");
  const depth = commander ? 80 : 60;
  const outside = [point(0, 0, 0), point(100, 0, 0), point(100, 0, depth), point(0, 0, depth)];
  const inside = [point(wall, 0, wall), point(100 - wall, 0, wall), point(100 - wall, 0, depth - wall), point(wall, 0, depth - wall)];
  const rim = path(outside) + " " + path([...inside].reverse());
  return <>
    <svg className="deck-box-body" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-side`}><stop stopColor="var(--deck-paint)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 68%, #06090c)" /></linearGradient>
        <linearGradient id={`${id}-well`} x2="0" y2="1"><stop stopColor="#05080b" /><stop offset="1" stopColor="#1b272b" /></linearGradient>
        <clipPath id={`${id}-opening`}><path d={path(inside)} /></clipPath>
      </defs>
      <path className="deck-box-solid" d={path([point(0, 0, 0), point(100, 0, 0), point(100, 0, depth), point(100, height, depth), point(100, height, 0), point(0, height, 0)])} />
      <path className="deck-box-shell-side" d={path([point(100, 0, 0), point(100, 0, depth), point(100, height, depth), point(100, height, 0)])} fill={`url(#${id}-side)`} />
      <path className="deck-box-heel" d={path([point(100, height - 6, 0), point(100, height - 6, depth), point(100, height, depth), point(100, height, 0)])} />
      {!foreground && <g clipPath={`url(#${id}-opening)`}>
        <path className="deck-box-well" d={path(outside)} fill={`url(#${id}-well)`} />
        <path className="deck-box-inner-back" d={path([inside[3], inside[2], point(100 - wall, 25, depth - wall), point(wall, 25, depth - wall)])} />
        <path className="deck-box-inner-side" d={path([inside[1], inside[2], point(100 - wall, 25, depth - wall), point(100 - wall, 25, wall)])} />
        <path className="deck-box-inner-left" d={path([inside[0], inside[3], point(wall, 25, depth - wall), point(wall, 25, wall)])} />
      </g>}
    </svg>
    <svg className="deck-box-mouth" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {foreground
        ? <path className="deck-box-rim" d={path([outside[0], outside[1], inside[1], inside[0]]) + " " + path([outside[1], outside[2], inside[2], inside[1]])} />
        : <>
          <path className="deck-box-rim" d={rim} fillRule="evenodd" />
          <path className="deck-box-rim-edge" d={path(inside)} />
          <path className="deck-box-hinge" d={path([point(9, lidBottom - 2, depth), point(91, lidBottom - 2, depth), point(91, lidBottom + 2, depth), point(9, lidBottom + 2, depth)])} />
        </>}
      <path className="deck-box-front-edge" d={path([point(0, 0, 0), point(100, 0, 0), point(100, 4, 0), point(0, 4, 0)])} />
    </svg>
  </>;
}

function capFaces(depth: number): Face[] {
  const x0 = -2, x1 = 102, z0 = -2, z1 = depth + 2, top = -6;
  const innerLeft = 3, innerRight = 97, innerFront = 3, innerBack = depth - 3, ceiling = -1;
  const face = (name: string, points: Point[], normal: Point, finish: string): Face => ({ name, points, normal, finish });
  return [
    face("top", [point(x0, top, z0), point(x1, top, z0), point(x1, top, z1), point(x0, top, z1)], point(0, -1, 0), "top"),
    face("front", [point(x0, top, z0), point(x1, top, z0), point(x1, lidBottom, z0), point(x0, lidBottom, z0)], point(0, 0, -1), "front"),
    face("right", [point(x1, top, z0), point(x1, top, z1), point(x1, lidBottom, z1), point(x1, lidBottom, z0)], point(1, 0, 0), "side"),
    face("back", [point(x0, top, z1), point(x1, top, z1), point(x1, lidBottom, z1), point(x0, lidBottom, z1)], point(0, 0, 1), "side"),
    face("left", [point(x0, top, z0), point(x0, top, z1), point(x0, lidBottom, z1), point(x0, lidBottom, z0)], point(-1, 0, 0), "side"),
    face("lining", [point(innerLeft, ceiling, innerFront), point(innerRight, ceiling, innerFront), point(innerRight, ceiling, innerBack), point(innerLeft, ceiling, innerBack)], point(0, 1, 0), "lining"),
    face("inner-front", [point(innerLeft, ceiling, innerFront), point(innerRight, ceiling, innerFront), point(innerRight, lidBottom, innerFront), point(innerLeft, lidBottom, innerFront)], point(0, 0, 1), "inner"),
    face("inner-back", [point(innerLeft, ceiling, innerBack), point(innerRight, ceiling, innerBack), point(innerRight, lidBottom, innerBack), point(innerLeft, lidBottom, innerBack)], point(0, 0, -1), "inner"),
    face("inner-right", [point(innerRight, ceiling, innerFront), point(innerRight, ceiling, innerBack), point(innerRight, lidBottom, innerBack), point(innerRight, lidBottom, innerFront)], point(-1, 0, 0), "inner"),
    face("inner-left", [point(innerLeft, ceiling, innerFront), point(innerLeft, ceiling, innerBack), point(innerLeft, lidBottom, innerBack), point(innerLeft, lidBottom, innerFront)], point(1, 0, 0), "inner"),
    face("front-rim", [point(x0, lidBottom, z0), point(x1, lidBottom, z0), point(innerRight, lidBottom, innerFront), point(innerLeft, lidBottom, innerFront)], point(0, 1, 0), "rim"),
    face("right-rim", [point(x1, lidBottom, z0), point(x1, lidBottom, z1), point(innerRight, lidBottom, innerBack), point(innerRight, lidBottom, innerFront)], point(0, 1, 0), "rim"),
    face("back-rim", [point(x1, lidBottom, z1), point(x0, lidBottom, z1), point(innerLeft, lidBottom, innerBack), point(innerRight, lidBottom, innerBack)], point(0, 1, 0), "rim"),
    face("left-rim", [point(x0, lidBottom, z1), point(x0, lidBottom, z0), point(innerLeft, lidBottom, innerFront), point(innerLeft, lidBottom, innerBack)], point(0, 1, 0), "rim"),
  ];
}

export function DeckBoxLid({ commander, emblem, opening }: { commander: boolean; emblem: CaseEmblem; opening: boolean }) {
  const id = useId().replace(/:/g, "");
  const element = useRef<SVGSVGElement>(null);
  const [angle, setAngle] = useState(0);
  const depth = commander ? 80 : 60;
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const rotate = ({ x, y, z }: Point): Point => ({ x, y: lidBottom + (y - lidBottom) * cosine + (z - depth - 2) * sine, z: depth + 2 + (z - depth - 2) * cosine - (y - lidBottom) * sine });
  const normal = ({ x, y, z }: Point): Point => ({ x, y: y * cosine + z * sine, z: z * cosine - y * sine });
  const faces = capFaces(depth).filter(face => {
    const n = normal(face.normal);
    return n.x * across - n.y * rise - n.z > .001;
  }).map(face => ({ ...face, points: face.points.map(rotate) })).sort((a, b) => depthOrder(a.points) - depthOrder(b.points));
  const front = project(rotate(point(-2, -6, -2)));
  const stampStyle = {
    transform: `translate(calc(${front.x} * var(--deck-unit)), calc(${front.y} * var(--deck-unit))) matrix(1, 0, ${-across * sine}, ${cosine + rise * sine}, 0, 0)`,
    visibility: cosine + rise * sine > .001 ? "visible" : "hidden",
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!opening || !element.current) return;
    // The browser animation supplies the clock; pausing or finishing the
    // opening also controls the hinge. Only its geometry changes per frame.
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

  return <>
    <svg ref={element} className="deck-box-lid" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" data-hinge-angle={angle.toFixed(2)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-top`} x2=".5" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 82%, #d5d9cb)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
        <linearGradient id={`${id}-front`} x2=".2" y2="1"><stop stopColor="color-mix(in srgb, var(--deck-paint) 94%, #c2c8bd)" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
        <linearGradient id={`${id}-side`}><stop stopColor="var(--deck-paint)" /><stop offset="1" stopColor="color-mix(in srgb, var(--deck-paint) 64%, #080b0d)" /></linearGradient>
        <linearGradient id={`${id}-lining`} x2="0" y2="1"><stop stopColor="#1b272a" /><stop offset="1" stopColor="#0a1014" /></linearGradient>
        <linearGradient id={`${id}-inner`} x2="0" y2="1"><stop stopColor="#080d10" /><stop offset="1" stopColor="#293438" /></linearGradient>
        <linearGradient id={`${id}-rim`}><stop stopColor="color-mix(in srgb, var(--deck-paint) 65%, var(--deck-trim))" /><stop offset="1" stopColor="var(--deck-paint)" /></linearGradient>
      </defs>
      {faces.map(face => <path key={face.name} className={`deck-box-cap-face deck-box-cap-${face.name}`} d={path(face.points)} fill={`url(#${id}-${face.finish})`} stroke={`url(#${id}-${face.finish})`} strokeWidth=".7" strokeLinejoin="round" />)}
    </svg>
    <span className="deck-box-seam" style={stampStyle}><span className="deck-box-stamp"><DeckEmblem emblem={emblem} commander={commander} /><span>PakTrak</span></span><span className="deck-box-clasp" /><span className="deck-box-light" /></span>
  </>;
}

import { useId, useState } from "react";
import { money, type HistoryChange, type HistoryPoint } from "./api";

const W = 320, H = 96, PAD = 6;
const day = (value: string) => new Date(value + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function changeText(change: HistoryChange) {
  if (!change) return null;
  const amount = Number(change.amount);
  const direction = amount > 0 ? "Up" : amount < 0 ? "Down" : "No change";
  if (!amount) return `No change since ${day(change.since)}`;
  return `${direction} ${money(Math.abs(amount))}${change.percent != null ? ` (${Math.abs(change.percent)}%)` : ""} since ${day(change.since)}`;
}

/** One series over time: a thin line, a hover/touch readout and a table for screen readers. */
export default function ValueChart({ points, label, empty }: { points: HistoryPoint[]; label: string; empty: string }) {
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  if (points.length < 2) return <p className="fine value-chart-empty">{empty}</p>;
  const values = points.map((point) => Number(point.amount));
  const low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  const x = (index: number) => PAD + (index / (points.length - 1)) * (W - PAD * 2);
  const y = (value: number) => H - PAD - ((value - low) / span) * (H - PAD * 2);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const shown = active ?? points.length - 1;
  function pick(clientX: number, box: DOMRect) {
    const ratio = (clientX - box.left) / box.width;
    setActive(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  }
  return <figure className="value-chart">
    <figcaption className="value-chart-readout" aria-live="polite"><strong>{money(points[shown].amount)}</strong><span>{day(points[shown].day)}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${money(values[0])} on ${day(points[0].day)} to ${money(values[values.length - 1])} on ${day(points[points.length - 1].day)}`} aria-describedby={tableId}
      onPointerMove={(event) => pick(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerDown={(event) => pick(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setActive(null)}>
      <line className="value-chart-base" x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} vectorEffect="non-scaling-stroke" />
      <path className="value-chart-line" d={path} vectorEffect="non-scaling-stroke" />
      {active !== null && <line className="value-chart-cross" x1={x(active)} x2={x(active)} y1={PAD} y2={H - PAD} vectorEffect="non-scaling-stroke" />}
      <circle className="value-chart-dot" cx={x(shown)} cy={y(values[shown])} r="4" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="value-chart-axis" aria-hidden="true"><span>{day(points[0].day)}</span><span>{day(points[points.length - 1].day)}</span></div>
    <table id={tableId} className="sr-only"><caption>{label}</caption><thead><tr><th>Day</th><th>Value</th></tr></thead>
      <tbody>{points.map((point) => <tr key={point.day}><td>{point.day}</td><td>{money(point.amount)}</td></tr>)}</tbody></table>
  </figure>;
}

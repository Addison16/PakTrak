import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import "./loading.css";

/** A small turning ring, matching the pull-to-refresh spinner. */
export function Spinner() {
  return <svg className="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" opacity=".18" /><path d="M20 12a8 8 0 0 0-8-8" />
  </svg>;
}

/**
 * Status line with a spinner. After a few seconds a second line explains the wait,
 * so a slow load on a big collection never looks frozen.
 */
export function LoadingNote({ children, slow, className = "" }: { children: ReactNode; slow?: string; className?: string }) {
  const [late, setLate] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setLate(true), 4000); return () => clearTimeout(timer); }, []);
  return <span className={"loading-note " + className} role="status">
    <Spinner /><span>{children}{slow && late && <small className="loading-slow">{slow}</small>}</span>
  </span>;
}

/** Card-shaped placeholders that sit in the collection grid until the cards arrive. */
export function CardSkeletons({ count, start = 0 }: { count: number; start?: number }) {
  return <>{Array.from({ length: count }, (_, index) => <li key={"skeleton-" + index} className="skeleton-card" aria-hidden="true" style={{ "--skeleton-delay": `${(start + index) * 90}ms` } as CSSProperties}>
    <span className="skeleton-art skeleton" /><span className="skeleton-info"><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /><span className="skeleton skeleton-line price" /></span>
  </li>)}</>;
}

/** Deck-box-shaped placeholders for the deck list. */
export function DeckSkeletons({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, index) => <li key={"skeleton-" + index} className="skeleton-deck" aria-hidden="true" style={{ "--skeleton-delay": `${index * 110}ms` } as CSSProperties}>
    <span className="skeleton-deck-box"><span className="skeleton skeleton-deck-case" /></span>
    <span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" />
  </li>)}</>;
}

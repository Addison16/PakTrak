import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./scan-qol.css";

export type ViewerImage = { src: string; label: string; fallback?: string };

export default function ImageViewer({ images, initialIndex = 0, onClose }: { images: ViewerImage[]; initialIndex?: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const title = useId();
  const [index, setIndex] = useState(Math.max(0, Math.min(images.length - 1, initialIndex)));
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [retry, setRetry] = useState(0);
  const image = images[index] || images[0];
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow, gutter = document.documentElement.style.scrollbarGutter;
    element.showModal(); heading.current?.focus(); document.body.style.overflow = "hidden";
    // The viewer fills the screen, so give it the scrollbar space too.
    document.documentElement.style.scrollbarGutter = "auto";
    return () => { element.close(); document.body.style.overflow = overflow; document.documentElement.style.scrollbarGutter = gutter; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setFailed(false); setUsingFallback(false); setZoom(1); viewport.current?.scrollTo(0, 0); }, [index]);
  return <dialog ref={dialog} className="scan-image-viewer" aria-labelledby={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><span className="eyebrow">LOOK CLOSER</span><h2 ref={heading} id={title} tabIndex={-1}>{image.label}</h2></div><button className="menu-close" aria-label="Close enlarged photo" onClick={onClose}><Icon name="close" /></button></header>
    <div className="scan-viewer-toolbar">
      {images.length > 1 && <div className="scan-viewer-tabs" role="group" aria-label="Compare images">{images.map((item, i) => <button className="button secondary" aria-pressed={index === i} key={item.label} onClick={() => setIndex(i)}>{item.label}</button>)}</div>}
      <div className="scan-viewer-zoom" role="group" aria-label="Image magnification"><button className="button secondary" disabled={zoom <= 1} aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - 1))}>−</button><span aria-live="polite">{zoom}×</span><button className="button secondary" disabled={zoom >= 4} aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value + 1))}>+</button><button className="text-button" onClick={() => { setZoom(1); viewport.current?.scrollTo(0, 0); }}>Fit image</button></div>
    </div>
    <div ref={viewport} className="scan-viewer-viewport" data-fit={zoom === 1 || undefined} tabIndex={0} role="region" aria-label="Enlarged image. Scroll to inspect details." style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
      {failed ? <div className="scan-viewer-missing" role="status"><p>This image could not be loaded.</p><button className="button secondary" onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>Retry image</button></div> : <img key={`${index}-${retry}-${usingFallback}`} src={usingFallback ? image.fallback : image.src} alt={image.label} style={{ width: `${zoom * 100}%` }} onError={() => { if (image.fallback && !usingFallback && image.fallback !== image.src) setUsingFallback(true); else setFailed(true); }} />}
    </div>
    <p className="scan-viewer-hint">Zoom in, then scroll to inspect the name, artwork and collector number. Press Escape to close.</p>
  </dialog>;
}

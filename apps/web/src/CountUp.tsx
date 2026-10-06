import { useEffect, useRef, useState } from "react";

// Rolls a number to its new value when it changes. The first value and
// reduced-motion settings show the number directly.
export default function CountUp({ value, format = (n) => Math.round(n).toLocaleString() }: { value: number; format?: (value: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current; from.current = value;
    if (start === value || !Number.isFinite(start) || matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    const began = performance.now();
    let frame = requestAnimationFrame(function tick(time) {
      const t = Math.min(1, (time - began) / 450), eased = 1 - (1 - t) ** 3;
      setShown(start + (value - start) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => { cancelAnimationFrame(frame); setShown(value); };
  }, [value]);
  return <>{format(shown)}</>;
}

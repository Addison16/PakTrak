type IconName = "user" | "camera" | "batches" | "collection" | "decks" | "transfer" | "settings" | "image" | "arrow" | "spark" | "pin" | "close" | "light" | "frame";

const paths: Record<IconName, string> = {
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2",
  camera: "M4 6h4l2-3h4l2 3h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm12 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z",
  batches: "M7 3h10M5 6h14M4 9h16v12H4V9Zm5 5 3 3 3-3",
  collection: "M3 4h5v16H3V4Zm8 0h4v16h-4V4Zm7 0 3 1v15l-3-1V4Z",
  decks: "m4 5 9-2 3 15-9 2L4 5Zm13 0 3 1v15l-9-1",
  transfer: "M7 3v15m-4-4 4 4 4-4M17 21V6m-4 4 4-4 4 4",
  settings: "M4 7h7m4 0h5M4 17h2m4 0h10M11 4v6h4V4h-4ZM6 14v6h4v-6H6Z",
  image: "M3 4h18v16H3V4Zm0 12 5-5 5 5 4-4 4 4M16 8h.01",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  spark: "m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6L12 2Z",
  pin: "M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0ZM15 9a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
  close: "m6 6 12 12M18 6 6 18",
  light: "m13 2-9 12h7l-1 8 10-13h-8l1-7Z",
  frame: "M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5M8 3v18M16 3v18M3 8h18M3 16h18",
};

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

/**
 * A random UUID for request keys and list item ids. `crypto.randomUUID` only
 * exists on HTTPS addresses and localhost, so PakTrak opened at a plain
 * http:// address (for example http://192.168.1.50:8095) builds one from
 * `crypto.getRandomValues`, which every browser offers everywhere.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

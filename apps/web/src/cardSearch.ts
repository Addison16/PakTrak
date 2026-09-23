// Keep the trailing collector-number syntax aligned with scanner.card_search.
export function splitCollectorSearch(query: string) {
  const text = query.trim();
  const match = /^(.*?)\s*#\s*([^\s#]{1,32})$/.exec(text);
  return match ? { text: match[1].trim(), collectorNumber: match[2] } : { text, collectorNumber: "" };
}

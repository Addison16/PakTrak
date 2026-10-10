// Lets each browser choose how PakTrak animates (My account > Appearance >
// Animations sets <html data-motion="on|auto|off">). Stylesheets keep plain
// prefers-reduced-motion queries; at build time:
//   reduce        rules apply on a reduce-motion device unless data-motion="on",
//                 and are copied without the query for data-motion="off";
//   no-preference rules apply unless data-motion="off", and are copied without
//                 the query for data-motion="on".
// The added html condition sits in :where(), so specificity doesn't change.

import type { AtRule, Node, Plugin, Rule } from "postcss";

const query = /\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)/;
const insideKeyframes = (rule: Rule) => { for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) if (parent.type === "atrule" && /keyframes$/.test((parent as AtRule).name)) return true; return false; };
const scope = (rule: Rule, condition: string) => {
  rule.selectors = rule.selectors.map((selector) => /^(html|:root)\b/.test(selector)
    ? selector.replace(/^(html|:root)/, `$1:where(${condition})`)
    : `:where(html${condition}) ${selector}`);
};

export default function motionPreference(): Plugin {
  const done = new WeakSet<Node>();
  return {
    postcssPlugin: "paktrak-motion-preference",
    AtRule: {
      media(media: AtRule) {
        const match = media.params.match(query);
        if (!match || done.has(media)) return;
        done.add(media);
        const reduce = match[1] === "reduce";
        const copy = media.clone();
        done.add(copy);
        media.walkRules((rule) => { if (!insideKeyframes(rule)) scope(rule, reduce ? ':not([data-motion="on"])' : ':not([data-motion="off"])'); });
        copy.walkRules((rule) => { if (!insideKeyframes(rule)) scope(rule, reduce ? '[data-motion="off"]' : '[data-motion="on"]'); });
        copy.params = copy.params.replace(/\s*and\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)|\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)(\s*and)?\s*/, "").trim();
        media.parent!.insertAfter(media, copy.params ? copy : copy.nodes);
      },
    },
  };
}

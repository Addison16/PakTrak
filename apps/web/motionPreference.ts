// Lets a browser play PakTrak's animations even when the device asks for less
// motion (My account > Appearance > Animations sets <html data-motion="on">).
// Stylesheets keep plain prefers-reduced-motion queries; at build time:
//   reduce        rules apply only without data-motion="on";
//   no-preference rules are copied for data-motion="on" without the query.
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
        if (match[1] === "reduce") {
          media.walkRules((rule) => { if (!insideKeyframes(rule)) scope(rule, ':not([data-motion="on"])'); });
          return;
        }
        const copy = media.clone();
        done.add(copy);
        copy.walkRules((rule) => { if (!insideKeyframes(rule)) scope(rule, '[data-motion="on"]'); });
        copy.params = copy.params.replace(/\s*and\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)|\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)(\s*and)?\s*/, "").trim();
        media.parent!.insertAfter(media, copy.params ? copy : copy.nodes);
      },
    },
  };
}

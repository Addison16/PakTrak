import { useState } from "react";
import { hasReferral, storeEntryLink, storeList, storeNames, type Store, type StoreLine, type StoreLinks } from "./storeLinks";

export function ReferralNote({ links }: { links?: StoreLinks }) {
  return hasReferral(links) ? <p className="fine">Store links from this PakTrak include its owner’s referral code, which may earn them a commission at no cost to you.</p> : null;
}

export default function StoreButtons({ stores, cards, exact, links, primary, short }: { stores: Store[]; cards: StoreLine[]; exact: boolean; links?: StoreLinks; primary?: boolean; short?: boolean }) {
  const [message, setMessage] = useState("");
  if (!cards.length) return null;
  return <>
    <div className="actions">{stores.map((store) => {
      const list = storeList(store, cards, exact);
      const link = storeEntryLink(store, list, links);
      return <a key={store} className={primary ? "button primary" : "button secondary"} href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => {
        const done = link.prefilled ? `Opened ${storeNames[store]} with the list filled in. It’s copied too, in case the page opens empty.` : `List copied. Paste it into ${storeNames[store]}’s page.`;
        if (!navigator.clipboard) { setMessage(link.prefilled ? `Opened ${storeNames[store]} with the list filled in.` : "Copy the list, then paste it into the store page."); return; }
        void navigator.clipboard.writeText(list).then(() => setMessage(done), () => setMessage(link.prefilled ? `Opened ${storeNames[store]} with the list filled in.` : "Copy the list, then paste it into the store page."));
      }}>{short ? `${storeNames[store]} ↗` : `Open in ${storeNames[store]} ↗`}</a>;
    })}</div>
    {message && <p className="fine" role="status">{message}</p>}
  </>;
}

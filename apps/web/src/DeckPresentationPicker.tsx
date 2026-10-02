import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { cardCover, caseAppearance, caseEmblems, caseFinishes, DeckEmblem, presentationCovers, type CaseEmblem, type CaseFinish, type DeckPresentation } from "./deckPresentation";
import type { Deck } from "./deckTypes";
import "./deck-presentation.css";

type Props = { deck: Deck; presentation: DeckPresentation; onSave: (presentation: DeckPresentation) => boolean; onReset: () => boolean; onClose: () => void };

function CaseArtwork({ url, emblem, commander = false, lazy = false }: { url: string | null | undefined; emblem?: CaseEmblem; commander?: boolean; lazy?: boolean }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  return <><DeckEmblem emblem={emblem} commander={commander} />{url && !failed && <img className="deck-presentation-artwork-image" src={url} alt="" loading={lazy ? "lazy" : "eager"} decoding="async" data-ready={ready || undefined} onLoad={() => setReady(true)} onError={() => setFailed(true)} />}</>;
}

export default function DeckPresentationPicker({ deck, presentation, onSave, onReset, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const [draft, setDraft] = useState<DeckPresentation>(presentation);
  const [error, setError] = useState("");
  const cards = deck.cards.filter((card, index, all) => card.quantity > 0 && all.findIndex((item) => item.printing.id === card.printing.id) === index).map(cardCover);
  const cover = presentationCovers(deck, draft)[0];
  const finish = caseAppearance(deck, draft);
  const selectedEmblem = draft.emblem === "automatic" ? deck.format === "commander" ? "crown" : "cards" : draft.emblem;

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => { if (error) dialog.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest" }); }, [error]);

  const save = () => { if (onSave(draft)) onClose(); else setError("Your browser could not save this case. Try allowing site storage and save again."); };
  const reset = () => { if (onReset()) onClose(); else setError("Your browser could not reset this case. Try allowing site storage and reset again."); };

  return <dialog ref={dialog} className="deck-presentation-dialog" aria-labelledby={title} aria-describedby={description} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="deck-presentation-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2 id={title}>Customize your case</h2></div><button type="button" className="text-button" aria-label="Cancel case customization" onClick={onClose}>Close ×</button></div>
    <div className="deck-presentation-scroll">
    <p id={description} className="deck-presentation-intro">A signature look for {deck.name}. Saved to your account on this device.</p>
    <div className="deck-presentation-body">
      <div className="deck-presentation-preview" style={{ "--case-paint": finish.paint, "--case-accent": finish.accent } as CSSProperties} aria-label="Case preview">
        <span className="deck-presentation-preview-top"><DeckEmblem emblem={draft.emblem} commander={deck.format === "commander"} /><span>PakTrak</span></span>
        <span className="deck-presentation-preview-art"><CaseArtwork key={cover?.art_url || cover?.image_url || "empty"} url={cover?.art_url || cover?.image_url} emblem={draft.emblem} commander={deck.format === "commander"} /></span>
        <span className="deck-presentation-preview-name">{deck.name}</span>
      </div>
      <div className="deck-presentation-options">
        <fieldset><legend>Case finish{draft.finish === "automatic" && <span className="deck-presentation-original">Original finish</span>}</legend><div className="deck-presentation-finishes">{(Object.keys(caseFinishes) as CaseFinish[]).filter(key => key !== "automatic").map((key) => <label key={key} className="deck-presentation-finish"><input type="radio" name="case-finish" value={key} checked={draft.finish === key} onChange={() => setDraft((value) => ({ ...value, finish: key }))} /><span className="deck-presentation-swatch" style={{ "--swatch": caseFinishes[key].paint! } as CSSProperties} /><span>{caseFinishes[key].label}</span></label>)}</div></fieldset>
        <fieldset><legend>Emblem</legend><div className="deck-presentation-emblems">{(Object.keys(caseEmblems) as CaseEmblem[]).filter(key => key !== "automatic").map((key) => <label key={key} className="deck-presentation-emblem" title={caseEmblems[key]}><input type="radio" name="case-emblem" value={key} checked={selectedEmblem === key} onChange={() => setDraft((value) => ({ ...value, emblem: key }))} /><span>{key === "none" ? <span aria-hidden="true">—</span> : <DeckEmblem emblem={key} />}</span><span>{caseEmblems[key]}</span></label>)}</div></fieldset>
      </div>
    </div>
    <fieldset className="deck-presentation-featured"><legend>Featured artwork</legend><div className="deck-presentation-artwork">
      <label className="deck-presentation-art-choice automatic"><input type="radio" name="case-artwork" value="automatic" checked={!draft.featuredCard} onChange={() => setDraft((value) => ({ ...value, featuredCard: null }))} /><span><DeckEmblem commander={deck.format === "commander"} /></span><strong>Automatic</strong><small>{deck.format === "commander" ? "Commander artwork" : "Deck artwork"}</small></label>
      {cards.map((card) => <label key={card.id} className="deck-presentation-art-choice"><input type="radio" name="case-artwork" value={card.id} checked={draft.featuredCard?.id === card.id} onChange={() => setDraft((value) => ({ ...value, featuredCard: card }))} /><span><CaseArtwork key={card.image_url} url={card.image_url} lazy /></span><strong>{card.name}</strong></label>)}
    </div>{!cards.length && <p className="muted">Add cards to this deck to choose featured artwork.</p>}</fieldset>
    {error && <p className="notice error" role="alert">{error}</p>}
    </div>
    <div className="deck-presentation-actions"><button type="button" className="text-button" onClick={reset}>Restore original case</button><span /><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button" onClick={save}>Save case</button></div>
  </dialog>;
}

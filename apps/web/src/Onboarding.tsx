import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./onboarding.css";

const steps = [
  {
    title: "Make room for your collection.",
    copy: "Welcome to PakTrak. Keep your cards, prices and deck ideas together. No upload needed.",
    note: "The Menu button at the top opens every section. Start anywhere.",
    label: "A quick look around",
  },
  {
    title: "Find the card you need.",
    copy: "Search and filter in Collection, then choose your saved price source. Sort prices low to high or high to low.",
    note: "Open a card to see its copies and storage locations.",
    label: "Your collection, in reach",
  },
  {
    title: "Add cards when you’re ready.",
    copy: "Import a CSV or text list in Import / export, or use Upload photo and review each card before adding it.",
    note: "After the server accepts a photo, find its progress and review in Batches.",
    label: "Go at your own pace",
  },
  {
    title: "Build a place for every card.",
    copy: "Keep deck ideas in Decks and organize storage locations in Collection. Use Import / export to take your collection list with you.",
    note: "Reopen this guide anytime from Menu → Quick tour.",
    label: "Ready when you are",
  },
];

function MiniCard({ variant = 0 }: { variant?: number }) {
  return <span className={`tour-mini-card tour-mini-card-${variant}`}><Icon name="spark" /><i /><i /></span>;
}

function Preview({ step }: { step: number }) {
  return <div className={`tour-preview tour-preview-${step}`} aria-hidden="true">
    {step === 0 && <div className="tour-mini-window">
      <div className="tour-mini-topbar"><strong>Pak<span>Trak</span></strong><span className="tour-mini-menu"><span>☰</span> Menu</span></div>
      <div className="tour-mini-workspace"><div className="tour-mini-cards"><MiniCard /><MiniCard variant={1} /></div>
        <div className="tour-mini-drawer"><span><Icon name="collection" />Collection</span><span><Icon name="decks" />Decks</span><span><Icon name="transfer" />Import / export</span></div>
      </div>
    </div>}
    {step === 1 && <div className="tour-mini-library">
      <div className="tour-mini-search"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5" /><path d="m12 12 5 5" /></svg><span>Find a favorite…</span></div>
      <div className="tour-mini-library-row"><div className="tour-mini-cards"><MiniCard variant={1} /><MiniCard /><MiniCard variant={2} /></div><span className="tour-mini-sort">Price<Icon name="arrow" /><strong>Low to high</strong></span></div>
    </div>}
    {step === 2 && <div className="tour-mini-paths">
      <div><span className="tour-preview-icon"><Icon name="transfer" /></span><strong>Import a list</strong><span>CSV or text</span></div>
      <span className="tour-mini-or">or</span>
      <div><span className="tour-preview-icon"><Icon name="camera" /></span><strong>Review a photo</strong><span>Check each card</span></div>
    </div>}
    {step === 3 && <div className="tour-mini-organize">
      <div className="tour-mini-deck"><MiniCard variant={2} /><MiniCard variant={1} /><MiniCard /></div>
      <div className="tour-mini-places"><span><Icon name="decks" />Deck ideas</span><span><Icon name="pin" />A place for every card</span><span><Icon name="transfer" />Your list, to go</span></div>
    </div>}
  </div>;
}

export type OnboardingProps = { onDismiss: () => void; replay?: boolean };

export default function Onboarding({ onDismiss, replay = false }: OnboardingProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  const [step, setStep] = useState(0);
  const current = steps[step];
  const last = step === steps.length - 1;

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    if (!element.open) element.showModal();
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      const target = previous?.isConnected && previous !== document.body && previous !== document.documentElement && previous.getClientRects().length
        ? previous : document.querySelector<HTMLButtonElement>(".menu-trigger");
      target?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    dialog.current?.close();
    onDismiss();
  }

  return <dialog ref={dialog} className="onboarding-dialog" aria-label="Quick tour" aria-describedby="tour-copy"
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
    }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const active = document.activeElement;
      if (event.shiftKey && (active === buttons[0] || !buttons.some((button) => button === active))) {
        event.preventDefault(); buttons.at(-1)?.focus();
      } else if (!event.shiftKey && active === buttons.at(-1)) {
        event.preventDefault(); buttons[0]?.focus();
      }
    }}>
    <header className="tour-header"><span className="tour-wordmark">Pak<span>Trak</span><span className="tour-header-divider" />Quick tour</span><button type="button" className="tour-skip" onClick={dismiss}>Skip tour</button></header>
    <div ref={content} className="tour-content">
      <Preview step={step} />
      <p className="tour-eyebrow">{current.label}</p>
      <h2 ref={heading} className="tour-title" tabIndex={-1} aria-describedby="tour-progress">{current.title}</h2>
      <p id="tour-copy" className="tour-copy">{current.copy}</p>
      <p className="tour-note"><Icon name={step === 3 ? "spark" : step === 2 ? "batches" : step === 1 ? "pin" : "arrow"} /><span>{current.note}</span></p>
    </div>
    <footer className="tour-footer">
      <div className="tour-progress"><span id="tour-progress" aria-live="polite" aria-atomic="true">{step + 1} of {steps.length}</span><span className="tour-progress-dots" aria-hidden="true">{steps.map((_, index) => <i key={index} className={index === step ? "is-current" : index < step ? "is-done" : ""} />)}</span></div>
      <div className="tour-actions">{step > 0 && <button type="button" className="tour-back" onClick={() => setStep((value) => value - 1)}>Back</button>}<button type="button" className="tour-next" onClick={() => last ? dismiss() : setStep((value) => value + 1)}>{last ? replay ? "Done" : "Start exploring" : "Next"}{!last && <Icon name="arrow" />}</button></div>
    </footer>
  </dialog>;
}

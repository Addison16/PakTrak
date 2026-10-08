// A few of PakTrak's own cards drift down behind sign-in and Home. Styles live in
// public/backdrop-v1.css, shared with the identity pages' copy of this markup.
export default function FallingCards() {
  return <div className="falling-cards" aria-hidden="true">
    {Array.from({ length: 8 }, (_, i) => <i key={i} className="falling-card"><b><span className="falling-card-back" /><span className="falling-card-face" /></b></i>)}
  </div>;
}

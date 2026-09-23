import { money, providers } from "./api";
import type { Scan } from "./scanTypes";
import { Icon } from "./Icon";

export function batchNeedsReview(scan: Scan) {
  return !!scan.accepted_at && !!scan.summary?.cards && !["QUEUED", "RUNNING"].includes(scan.job?.state || "")
    && (!!scan.summary.needs_review || scan.finishes_confirmed === false);
}

export function batchStatus(scan: Scan) {
  if (scan.state === "FAILED") return "Needs attention";
  if (scan.job && ["QUEUED", "RUNNING"].includes(scan.job.state)) return scan.job.state === "QUEUED" ? "Queued on server" : "Identifying cards";
  if (!scan.accepted_at) return "Upload unfinished";
  if (scan.summary?.needs_review) return `${scan.summary.needs_review} to review`;
  if (scan.summary?.cards && scan.finishes_confirmed === false) return "Confirm finishes";
  if (scan.summary?.cards) return "Reviewed";
  return scan.state === "EXPIRED" ? "Photo expired" : "No cards found";
}

export default function BatchList({ scans, offset, nextOffset, onPage, onOpen, onUpload }: {
  scans: Scan[]; offset: number; nextOffset: number | null;
  onPage: (offset: number) => void; onOpen: (scan: Scan) => void; onUpload: () => void;
}) {
  return <section className="panel history" aria-labelledby="batches-title">
    <div className="section-heading"><div><div className="eyebrow">YOUR SCANS</div><h2 id="batches-title" tabIndex={-1}>Saved batches</h2></div>
      <button className="button secondary" onClick={onUpload}>New scan</button></div>
    <p className="batch-list-intro">Review card matches and choose foil cards here. Highlighted batches still have a step to finish.</p>
    {scans.length === 0 ? <p>{offset ? "No more batches on this page." : "No batches yet. Your uploaded photos will appear here."}</p> : <ul className="batch-list">
      {scans.map((scan) => {
        const previews = scan.preview_cards || [];
        const more = Math.max(0, (scan.summary?.cards || 0) - previews.length);
        const processing = !!scan.job && ["QUEUED", "RUNNING"].includes(scan.job.state);
        const needsReview = batchNeedsReview(scan);
        return <li key={scan.id}><button className="batch" data-batch-id={scan.id} data-needs-review={needsReview || undefined} onClick={() => onOpen(scan)}>
          {needsReview && <span className="batch-attention"><Icon name="spark" />Ready for your review</span>}
          <span className="batch-row-heading"><strong>{scan.filename}</strong><span className="batch-arrow" aria-hidden="true">→</span></span>
          <span className="batch-row-meta"><time dateTime={scan.created_at}>{new Date(scan.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
            <span className={"badge " + scan.state.toLowerCase()}>{batchStatus(scan)}</span></span>
          <span className="batch-strip" aria-hidden="true">
            {previews.length ? previews.map((card) => <span className="batch-mini" key={card.id} title={card.name}>
              {card.image_url ? <img src={card.image_url} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
              <span className="batch-mini-fallback">▧</span>
            </span>) : <><span className="batch-mini batch-photo">{scan.thumbnail_url ? <img src={scan.thumbnail_url} alt="" loading="lazy" /> : <span className="batch-mini-fallback">▧</span>}</span><span className="batch-preview-note">{processing ? "Card previews appear as scanning progresses" : scan.accepted_at ? "No card previews yet" : "Waiting for upload"}</span></>}
            {more > 0 && <span className="batch-more batch-more-wide">+{more}</span>}
            {(scan.summary?.cards || 0) > Math.min(4, previews.length) && <span className="batch-more batch-more-compact">+{(scan.summary?.cards || 0) - Math.min(4, previews.length)}</span>}
          </span>
          <span className="batch-row-summary"><span>{scan.summary?.cards || 0} cards · {scan.add_to_collection === false ? scan.summary?.confirmed || 0 : scan.summary?.imported || 0} {scan.add_to_collection === false ? "matched" : "imported"}</span>
            <span className="batch-row-value">{scan.summary?.value_min != null ? <>{money(scan.summary.value_min)}{scan.summary.value_max !== scan.summary.value_min ? "+" : ""} <small>estimate · {providers[scan.summary.provider] || "TCGplayer"}</small></> : "Awaiting prices"}</span></span>
          {processing && <span className="batch-row-progress"><progress max={Math.max(1, scan.summary?.regions || 1)} value={scan.summary?.checked || 0} aria-label="Batch progress" /><span>{scan.summary?.checked || 0} of {scan.summary?.regions || 0} checked</span></span>}
          <span className="batch-row-action"><span>{needsReview ? "Review batch" : processing ? "View progress" : !scan.accepted_at ? "Finish upload" : "View batch"} <Icon name="arrow" /></span>{needsReview && scan.finishes_confirmed === false && <small>Foil labels need checking</small>}</span>
        </button></li>;
      })}
    </ul>}
    {(offset > 0 || nextOffset !== null) && <div className="pagination">
      {offset > 0 && <button className="text-button" onClick={() => onPage(Math.max(0, offset - 20))}>Newer batches</button>}
      {nextOffset !== null && <button className="text-button" onClick={() => onPage(nextOffset)}>Older batches</button>}
    </div>}
  </section>;
}

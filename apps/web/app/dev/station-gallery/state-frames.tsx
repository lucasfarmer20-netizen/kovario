/**
 * A station's states on the gallery index: each one a live page (/dev/station-gallery/<id>)
 * framed at tablet (1280 × 800) and phone (400 × 860) widths, scaled to fit.
 */
export function StateFrames({
  states,
}: {
  states: readonly { id: string; title: string; note: string }[];
}) {
  return (
    <div className="st-gallery-states">
      {states.map((s) => (
        <article key={s.id} className="st-gallery-state">
          <header>
            <h3>
              <a href={`/dev/station-gallery/${s.id}`}>{s.title}</a>
            </h3>
            <p className="st-gallery-note">{s.note}</p>
          </header>
          <div className="st-gallery-frames">
            <div className="st-frame st-frame-tablet">
              <iframe
                title={`${s.title} at 1280 px`}
                src={`/dev/station-gallery/${s.id}`}
                loading="lazy"
              />
            </div>
            <div className="st-frame st-frame-phone">
              <iframe
                title={`${s.title} at 400 px`}
                src={`/dev/station-gallery/${s.id}`}
                loading="lazy"
              />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

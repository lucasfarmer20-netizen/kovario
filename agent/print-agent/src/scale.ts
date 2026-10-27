/** Toledo 8217 W-response framing, also supported by the BC60 Toledo protocol.
 * Bare numeric replies use the scale's configured lb unit (DECISION-11).
 * Status replies invalidate a pending sample; they never become an accepted weight.
 */
export type ScaleSample = { weightLb: number; stable: boolean };
export function parse8217(frame: string): ScaleSample | null {
  if (!frame.startsWith("\x02") || !frame.endsWith("\r")) return null;
  const body = frame.slice(1, -1);
  const match = /^\s*(\d{1,6}(?:\.\d{1,4})?)\s*(?:lb)?$/.exec(body);
  if (!match) return null;
  const weightLb = Number(match[1]);
  return Number.isFinite(weightLb) ? { weightLb, stable: true } : null;
}
export class Toledo8217Stream {
  private buffer = "";
  push(chunk: Uint8Array): Array<ScaleSample | null> {
    this.buffer += Buffer.from(chunk).toString("ascii");
    const samples: Array<ScaleSample | null> = [];
    for (;;) {
      const start = this.buffer.lastIndexOf(
        "\x02",
        this.buffer.indexOf("\r") >= 0 ? this.buffer.indexOf("\r") : undefined,
      );
      if (start < 0) {
        this.buffer = "";
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf("\r");
      if (end < 0) {
        if (this.buffer.length > 128) this.buffer = "";
        break;
      }
      samples.push(parse8217(this.buffer.slice(0, end + 1)));
      this.buffer = this.buffer.slice(end + 1);
    }
    return samples;
  }
}
/** Two identical stable replies separated by >=250ms; emit changes only. */
export class StableScale {
  private candidate: number | null = null;
  private since = 0;
  private emitted: number | null = null;
  retryFailed(): void {
    this.emitted = null;
  }
  update(sample: ScaleSample | null, now: number): ScaleSample | null {
    if (!sample?.stable) {
      this.candidate = null;
      return null;
    }
    if (this.candidate !== sample.weightLb) {
      this.candidate = sample.weightLb;
      this.since = now;
      return null;
    }
    if (now - this.since < 250 || this.emitted === sample.weightLb) return null;
    this.emitted = sample.weightLb;
    return sample;
  }
}

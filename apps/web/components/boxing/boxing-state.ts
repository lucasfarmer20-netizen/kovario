import { parse, releaseLineIssue, sameTagCode, type BoxPlanMethod } from "rules";

// Boxing / will-call screen state (docs/06-STATIONS-UX.md Boxing, docs/10-LESSONS-FROM-CSP.md
// §2). Box ticks and tote ticks are two independent facts the crew reports (I1): nothing here
// derives one from the other, and a scan only ever ticks a tote. The server re-checks all of
// it under lock (release_party); this module only keeps the form honest before Complete.

export type WizardBox = {
  box_id: string;
  number: string;
  settlement_id: string;
  angler_name: string;
  method: BoxPlanMethod;
  size: string | null;
  weight_lb: number;
  shipment_number: string | null;
  ship_date: string | null;
};

export type WizardVessel = {
  vessel_id: string;
  intake_id: string;
  intake_number: string;
  tag_code: string | null;
  is_exchange: boolean;
  weight_lb: number;
  species_summary: string | null;
  location_code: string | null;
  walk_seq: number;
};

export type WizardIntake = {
  intake_id: string;
  number: string;
  state: string;
  customer_name: string;
  dirty_fish: boolean;
  dirty_notes: string | null;
  cut_notes: string | null;
  processing_notes: string | null;
  ribbing: boolean;
  smoking: boolean;
  lines: {
    species: string;
    method: string;
    method_code: string;
    lb: number;
    notes: string | null;
  }[];
  other_sessions: string[];
};

/** public.boxing_wizard: exactly the planned boxes and occupied vessels in scope (I15). */
export type Wizard = {
  session_id: string;
  number: string;
  state: string;
  party_name: string | null;
  moved_before: boolean;
  finalized_count: number;
  anglers: { settlement_id: string; number: string; angler_name: string; state: string }[];
  boxes: WizardBox[];
  vessels: WizardVessel[];
  intakes: WizardIntake[];
};

export type VesselLine = {
  ticked: boolean;
  /** As typed; blank = full pull. */
  lbsLeft: string;
  /** The weight the screen showed when the line was touched (stale check, I16b). */
  measure: number;
};

export type Ticks = { boxes: string[]; vessels: Record<string, VesselLine> };

export const emptyTicks = (): Ticks => ({ boxes: [], vessels: {} });

export function vesselLabel(v: Pick<WizardVessel, "tag_code" | "is_exchange" | "intake_number">) {
  const name = v.tag_code
    ? `Basket ${v.tag_code}`
    : v.is_exchange
      ? "Exchange basket"
      : "Untagged basket";
  return `${name} (${v.intake_number})`;
}

export function toggleBox(ticks: Ticks, boxId: string): Ticks {
  const boxes = ticks.boxes.includes(boxId)
    ? ticks.boxes.filter((b) => b !== boxId)
    : [...ticks.boxes, boxId];
  return { ...ticks, boxes };
}

function line(ticks: Ticks, v: WizardVessel): VesselLine {
  return ticks.vessels[v.vessel_id] ?? { ticked: false, lbsLeft: "", measure: v.weight_lb };
}

/** I4/I5: the tick is the sole selector; unticking clears the line's remainder. */
export function toggleVessel(ticks: Ticks, v: WizardVessel): Ticks {
  const current = line(ticks, v);
  const next: VesselLine = current.ticked
    ? { ticked: false, lbsLeft: "", measure: v.weight_lb }
    : { ...current, ticked: true, measure: v.weight_lb };
  return { ...ticks, vessels: { ...ticks.vessels, [v.vessel_id]: next } };
}

/** Typing a remainder never ticks the line (I4): an unticked remainder is rejected instead. */
export function setLbsLeft(ticks: Ticks, v: WizardVessel, lbsLeft: string): Ticks {
  return {
    ...ticks,
    vessels: { ...ticks.vessels, [v.vessel_id]: { ...line(ticks, v), lbsLeft } },
  };
}

/** "" → null (full pull); anything unparseable → NaN so the rule rejects it. */
export function lbsValue(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  return /^\d*\.?\d+$/.test(t) || /^-\d*\.?\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** Input faults the server would abort on (I5 / I16a), named per line. */
export function lineIssues(wizard: Wizard, ticks: Ticks): { vesselId: string; message: string }[] {
  return wizard.vessels.flatMap((v) => {
    const l = ticks.vessels[v.vessel_id];
    if (!l) return [];
    const issue = releaseLineIssue(l.ticked, lbsValue(l.lbsLeft), v.weight_lb);
    return issue ? [{ vesselId: v.vessel_id, message: `${vesselLabel(v)}: ${issue}` }] : [];
  });
}

export type CompletePayload = {
  box_ticks: string[];
  vessel_ticks: { vessel_id: string; lbs_left: number | null; ticked: boolean; measure: number }[];
};

/**
 * What Complete sends: the ticked planned boxes, and every ticked tote line plus any unticked
 * line still carrying a remainder (so the server rejects it too rather than ignoring it, I5).
 */
export function completePayload(wizard: Wizard, ticks: Ticks): CompletePayload {
  const planned = new Set(wizard.boxes.map((b) => b.box_id));
  return {
    box_ticks: ticks.boxes.filter((b) => planned.has(b)),
    vessel_ticks: wizard.vessels.flatMap((v) => {
      const l = ticks.vessels[v.vessel_id];
      if (!l || (!l.ticked && l.lbsLeft.trim() === "")) return [];
      const lbs = lbsValue(l.lbsLeft);
      // Never send a bad value as blank: blank means full pull. lineIssues blocks first.
      if (lbs !== null && Number.isNaN(lbs))
        throw new RangeError(`${vesselLabel(v)}: fix Lbs Left before Complete`);
      return [{ vessel_id: v.vessel_id, lbs_left: lbs, ticked: l.ticked, measure: l.measure }];
    }),
  };
}

export const nothingTicked = (p: CompletePayload) =>
  p.box_ticks.length === 0 && !p.vessel_ticks.some((l) => l.ticked);

/**
 * I15: a fresh projection keeps ticks only for still-eligible records (still-planned boxes,
 * still-occupied vessels) and drops the rest with a stale-state notice. A vessel whose weight
 * changed is no longer the basket the crew selected: its tick AND its remainder are dropped,
 * so a refresh can never turn a split (or an untouched line) into a full pull of the new
 * weight — the crew re-ticks it and re-enters Lbs Left against the weight now shown.
 */
export function reproject(
  previous: Wizard | null,
  ticks: Ticks,
  next: Wizard,
): { ticks: Ticks; notices: string[] } {
  const notices: string[] = [];
  const planned = new Set(next.boxes.map((b) => b.box_id));
  const boxes = ticks.boxes.filter((id) => {
    if (planned.has(id)) return true;
    const number = previous?.boxes.find((b) => b.box_id === id)?.number ?? "A box";
    notices.push(`${number} is no longer planned (finalised elsewhere); its tick was dropped.`);
    return false;
  });
  const occupied = new Map(next.vessels.map((v) => [v.vessel_id, v]));
  const vessels: Record<string, VesselLine> = {};
  for (const [id, l] of Object.entries(ticks.vessels)) {
    const v = occupied.get(id);
    if (!v) {
      if (l.ticked || l.lbsLeft.trim() !== "") {
        const old = previous?.vessels.find((x) => x.vessel_id === id);
        notices.push(
          `${old ? vesselLabel(old) : "A basket"} is no longer in the freezer (released elsewhere); dropped.`,
        );
      }
      continue;
    }
    if (v.weight_lb !== l.measure) {
      if (l.ticked || l.lbsLeft.trim() !== "")
        notices.push(
          `${vesselLabel(v)} now holds ${v.weight_lb} lb; its tick was dropped — tick it again and re-enter Lbs Left.`,
        );
      continue;
    }
    vessels[id] = l;
  }
  return { ticks: { boxes, vessels }, notices };
}

export type ScanOutcome =
  | { kind: "ticked"; ticks: Ticks; message: string }
  | { kind: "box"; token: string }
  | { kind: "rejected"; message: string };

/**
 * A scan at boxing: an asset tag ticks its tote (never a box — I1); a boxing QR names a party
 * (the screen checks it is this one, I11); anything else is rejected. Untagged exchange
 * baskets are ticked by hand.
 */
export function scanTick(wizard: Wizard, ticks: Ticks, raw: string): ScanOutcome {
  const parsed = parse(raw);
  if (!parsed.ok) return { kind: "rejected", message: "Unreadable scan" };
  if (parsed.value.kind === "BOX") return { kind: "box", token: parsed.value.token };
  if (parsed.value.kind !== "TAG")
    return { kind: "rejected", message: "Scan a basket or the boxing QR" };
  // Any padding: a label printed before the org raised tag_digits names the same tag.
  const { code } = parsed.value;
  const v = wizard.vessels.find((x) => x.tag_code !== null && sameTagCode(x.tag_code, code));
  if (!v)
    return {
      kind: "rejected",
      message: `Basket ${code} is not on ${wizard.number}'s pick list`,
    };
  if (ticks.vessels[v.vessel_id]?.ticked)
    return { kind: "ticked", ticks, message: `${vesselLabel(v)} already ticked` };
  return { kind: "ticked", ticks: toggleVessel(ticks, v), message: `Ticked ${vesselLabel(v)}` };
}

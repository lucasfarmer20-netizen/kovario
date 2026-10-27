"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatPhone } from "rules";
import { Button, Input, Label } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import {
  KeystrokeTimer,
  canSearch,
  createDraft,
  moveHighlight,
  validateDraft,
  type CreateCustomerInput,
  type CreateCustomerResult,
  type CustomerHit,
} from "./customer-search-state";

const DEBOUNCE_MS = 200;

/**
 * Phone-first customer lookup (docs/06-STATIONS-UX.md, Intake): from 3 digits a live
 * dropdown shows name, phone, last visit and a lodge badge; ↑/↓ move, Enter picks, Esc
 * closes; the last option creates a customer inline. Scanner-safe: a keyboard-wedge burst
 * (or a QR payload from packages/rules qr.ts) ending in Enter is handed to `onScan` and never picks a customer.
 *
 * `search` / `create` are injected so the same component serves admin (Server Actions) and
 * stations (device session); `create` must pass `clientActionId` to `create_customer`.
 */
export function CustomerSearch({
  search,
  create,
  onSelect,
  onScan,
  label = "Customer phone or name",
  autoFocus,
}: {
  search: (q: string) => Promise<CustomerHit[]>;
  create?: (input: CreateCustomerInput) => Promise<CreateCustomerResult>;
  onSelect: (customer: CustomerHit) => void;
  onScan?: (raw: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; phone: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const keys = useRef(new KeystrokeTimer());
  const intentId = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Options: the hits, then "New customer" once a real query has been answered.
  const canCreate = Boolean(create) && searched !== null && searched === query;
  const optionCount = hits.length + (canCreate ? 1 : 0);

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    requestSeq.current++;
    keys.current.reset();
    setQuery("");
    setHits([]);
    setSearched(null);
    setHighlight(-1);
    setOpen(false);
  }

  function onChange(value: string) {
    if (value === "") keys.current.reset();
    setQuery(value);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    const seq = ++requestSeq.current;
    if (!canSearch(value)) {
      setHits([]);
      setSearched(null);
      setHighlight(-1);
      return;
    }
    timer.current = setTimeout(() => {
      search(value).then(
        (rows) => {
          if (seq !== requestSeq.current) return; // a newer keystroke owns the list
          setHits(rows);
          setSearched(value);
          setHighlight(rows.length > 0 ? 0 : -1);
          setOpen(true);
        },
        (err: unknown) => {
          if (seq !== requestSeq.current) return;
          setError(err instanceof Error ? err.message : "Search failed.");
        },
      );
    }, DEBOUNCE_MS);
  }

  function choose(index: number) {
    const hit = hits[index];
    if (hit) {
      onSelect(hit);
      clear();
    } else if (canCreate && index === hits.length) {
      intentId.current = null;
      setDraft(createDraft(query));
      setOpen(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key.length === 1) {
      keys.current.key(e.timeStamp);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (keys.current.isScan(query)) {
        const raw = query;
        clear();
        onScan?.(raw);
        return;
      }
      keys.current.reset();
      if (open && highlight >= 0) choose(highlight);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      keys.current.reset(); // scanners never send arrows: a person is choosing
      setOpen(true);
      setHighlight((h) => moveHighlight(h, optionCount, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Escape") {
      if (open) setOpen(false);
      else clear();
    }
  }

  async function submitDraft() {
    if (!draft || !create || creating) return;
    const valid = validateDraft(draft);
    if (!valid.ok) {
      setError(valid.error);
      return;
    }
    // One create intent keeps one client_action_id, so a double submit or a retry after a
    // lost response replays instead of creating a second customer.
    intentId.current ??= crypto.randomUUID();
    setCreating(true);
    setError(null);
    try {
      const result = await create({
        clientActionId: intentId.current,
        name: valid.name,
        phone: valid.phone,
      });
      if (result.customer) {
        intentId.current = null;
        setDraft(null);
        clear();
        onSelect(result.customer);
        inputRef.current?.focus();
      } else {
        setError(result.error ?? "Could not create the customer.");
      }
    } finally {
      setCreating(false);
    }
  }

  const activeId = open && highlight >= 0 ? `${id}-opt-${highlight}` : undefined;

  return (
    <div className="relative flex w-full max-w-xl flex-col gap-2">
      <Label htmlFor={`${id}-q`}>{label}</Label>
      <Input
        ref={inputRef}
        id={`${id}-q`}
        role="combobox"
        aria-expanded={open && optionCount > 0}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        inputMode="tel"
        autoFocus={autoFocus}
        className="h-12 text-lg"
        placeholder="(907) 555-…"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(searched !== null)}
        onBlur={() => setOpen(false)}
      />
      {open && optionCount > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-md"
        >
          {hits.map((hit, i) => (
            <li
              key={hit.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === highlight}
              className={cn(
                "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2",
                i === highlight && "bg-accent",
              )}
              // Keep focus in the input (no blur before the click lands).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              <span className="font-medium">{hit.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {hit.phone ? formatPhone(hit.phone) : "no phone"}
              </span>
              {hit.is_lodge_guest ? (
                <span className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                  {hit.lodge_name ?? "Lodge guest"}
                </span>
              ) : null}
              <span className="ml-auto text-sm text-muted-foreground">
                {hit.last_visit_at
                  ? `Last visit ${new Date(hit.last_visit_at).toLocaleDateString()}`
                  : "No visits yet"}
              </span>
            </li>
          ))}
          {canCreate ? (
            <li
              id={`${id}-opt-${hits.length}`}
              role="option"
              aria-selected={highlight === hits.length}
              className={cn(
                "flex min-h-12 cursor-pointer items-center px-3 py-2 font-medium",
                highlight === hits.length && "bg-accent",
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(hits.length)}
            >
              {hits.length === 0 ? "No match — new customer…" : "New customer…"}
            </li>
          ) : null}
        </ul>
      ) : null}

      {draft ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
        >
          <Label>
            Name
            <Input
              autoFocus
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Label>
          <Label>
            Phone
            <Input
              inputMode="tel"
              maxLength={30}
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
          </Label>
          <Button type="submit" disabled={creating}>
            Create
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDraft(null);
              setError(null);
              inputRef.current?.focus();
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

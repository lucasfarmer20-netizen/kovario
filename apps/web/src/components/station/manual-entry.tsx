"use client";
import { useEffect, useRef, useState } from "react";
import type { FilletryClient } from "db";
import { Keyboard, ScanLine } from "lucide-react";
import { parseManual, type ManualOptions, type ParseResult } from "rules";

export { ENTRY_METHOD_HEADER, withEntryMethod, type EntryMethod } from "./entry-method";

/**
 * A typed code → the text a scan of the same label sends, with its parse. A code that does
 * not read is submitted as typed, so the server rejects and logs it like a bad scan.
 */
export function readTypedCode(
  raw: string,
  options: ManualOptions = {},
): { text: string; parsed: ParseResult } {
  const typed = parseManual(raw, options);
  return typed.ok
    ? { text: typed.text, parsed: { ok: true, value: typed.value } }
    : { text: raw.trim(), parsed: typed };
}

/** The org's slug and `scanner.tag_digits` for typed codes; defaults until (or unless) loaded. */
export function useManualOptions(client: FilletryClient, orgId: string): ManualOptions {
  const [options, setOptions] = useState<ManualOptions>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const { data } = await client.from("org").select("slug,settings").eq("id", orgId).single();
      const settings = data?.settings as { scanner?: { tag_digits?: unknown } } | null;
      const digits = settings?.scanner?.tag_digits;
      if (live && data)
        setOptions({
          orgSlug: data.slug,
          ...(typeof digits === "number" ? { tagDigits: digits } : {}),
        });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, orgId]);
  return options;
}

/**
 * "Enter manually": a visible field with the normal on-screen keyboard for when the scanner is
 * dead (issue #84). Each entry goes to `onSubmit` like a scan; the field stays open for the
 * next code. No PIN or manager gate beyond the station's own. The station pauses its hidden
 * scanner input while this is open and refocuses it on close.
 */
export function ManualEntry({
  open,
  onOpenChange,
  onSubmit,
  disabled = false,
  options,
  label = "Code printed beside the QR",
  placeholder = "INT-0001-3 · 042 · IF-A-01-1-F",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (text: string, parsed: ParseResult) => void;
  disabled?: boolean;
  options?: ManualOptions;
  /** Names what's expected (docs/11-FLOOR-WORDING.md): "Basket number", "Tote number (INT-0002-1)". */
  label?: string;
  /** An example of what to type, e.g. "042" for a basket number. */
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);
  if (!open)
    return (
      <div className="station-manual">
        <button type="button" onClick={() => onOpenChange(true)}>
          <Keyboard size={22} aria-hidden />
          Enter manually
        </button>
      </div>
    );
  return (
    <form
      className="station-manual station-card"
      aria-label="Enter manually"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || value.trim() === "") return;
        const { text, parsed } = readTypedCode(value, options);
        setValue("");
        onSubmit(text, parsed);
        field.current?.focus({ preventScroll: true });
      }}
    >
      <label>
        {label}
        <input
          ref={field}
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
        />
      </label>
      <div className="station-actions">
        <button type="submit" disabled={disabled || value.trim() === ""}>
          Enter
        </button>
        <button
          type="button"
          onClick={() => {
            setValue("");
            onOpenChange(false);
          }}
        >
          <ScanLine size={22} aria-hidden />
          Close — back to scanner
        </button>
      </div>
    </form>
  );
}

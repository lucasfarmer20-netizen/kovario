"use client";
import type { Address } from "shipping";

const FIELDS: [keyof Address, string, string?][] = [
  ["name", "Name"],
  ["company", "Company"],
  ["street1", "Street"],
  ["street2", "Apt / suite"],
  ["city", "City"],
  ["state", "State", "w-16"],
  ["zip", "ZIP", "w-28"],
  ["country", "Country", "w-16"],
  ["phone", "Phone"],
  ["email", "Email"],
];

/** A ship-to / ship-from address (Shippo field names). */
export function AddressFields({
  value,
  onChange,
  idPrefix = "addr",
}: {
  value: Partial<Address>;
  onChange: (next: Partial<Address>) => void;
  idPrefix?: string;
}) {
  return (
    <div className="intake-fields">
      {FIELDS.map(([key, label, width]) => (
        <label key={key}>
          {label}
          <input
            id={`${idPrefix}-${key}`}
            className={width}
            value={value[key] ?? ""}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            autoComplete="off"
          />
        </label>
      ))}
    </div>
  );
}

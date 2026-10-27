import { Select } from "@/components/ui/form";

/** IANA time zones (the server re-checks against pg_timezone_names). */
export function TimezoneSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  const zones = Intl.supportedValuesOf("timeZone");
  const options = zones.includes(defaultValue) ? zones : [defaultValue, ...zones];
  return (
    <Select name={name} defaultValue={defaultValue} required>
      {options.map((z) => (
        <option key={z} value={z}>
          {z}
        </option>
      ))}
    </Select>
  );
}

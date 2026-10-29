import Link from "next/link";

export function StationsLink() {
  return (
    <Link
      href="/stations"
      className="inline-flex min-h-14 min-w-14 items-center justify-center px-4 text-lg underline"
    >
      Stations
    </Link>
  );
}

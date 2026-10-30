import Link from "next/link";
import { LayoutGrid } from "lucide-react";

export function StationsLink() {
  return (
    <Link
      href="/stations"
      className="inline-flex min-h-14 min-w-14 items-center justify-center gap-2 px-4 text-lg underline"
    >
      <LayoutGrid size={20} aria-hidden />
      <span className="st-hide-narrow">Stations</span>
    </Link>
  );
}

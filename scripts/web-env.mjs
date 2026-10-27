// `node scripts/web-env.mjs`: point apps/web at this worktree's running local Supabase stack.
// Reads URL and anon key from `supabase status` (which honours supabase/.env) and sets them in
// apps/web/.env.local, keeping any other lines. Run after `supabase start`, before `pnpm dev`.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let status;
try {
  const out = execSync("pnpm exec supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  status = JSON.parse(out.slice(out.indexOf("{")));
} catch {
  console.error("web-env: no running stack for this worktree; run `supabase start` first");
  process.exit(1);
}

const values = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
};
const file = join(root, "apps", "web", ".env.local");
const kept = existsSync(file)
  ? readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !Object.keys(values).some((k) => line.startsWith(`${k}=`)))
  : [];
const lines = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
writeFileSync(file, `${lines.join("\n")}\n`);
console.log(`web-env: apps/web/.env.local -> ${status.API_URL}`);

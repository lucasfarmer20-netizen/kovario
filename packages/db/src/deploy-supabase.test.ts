// #121 scripts/deploy-supabase.sh gates the auth email templates on SUPABASE_CUSTOM_EMAIL.
// Runs the real script offline against a stub `supabase` CLI that records each command and
// keeps the work-copy config.toml that `config push` would have sent.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = resolve(repoRoot, "supabase/config.toml");
const lf = (text: string) => text.replaceAll("\r\n", "\n");
const committed = () => lf(readFileSync(configPath, "utf8"));
const templateHeader = /^\s*\[auth\.email\.template\./;

/** The config with every [auth.email.template.*] table (header to the next header) removed. */
function withoutTemplates(toml: string): string {
  let skip = false;
  return toml
    .split("\n")
    .filter((line) => {
      if (/^\s*\[/.test(line)) skip = templateHeader.test(line);
      return !skip;
    })
    .join("\n");
}

/** `bash` on a Windows PATH is usually WSL's launcher; use Git for Windows' bash there. */
function bash(): string {
  if (process.platform !== "win32") return "bash";
  const gitCore = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  return resolve(gitCore, "../../../bin/bash.exe");
}

const stubDir = mkdtempSync(join(tmpdir(), "deploy-supabase-"));
const out = stubDir.replaceAll("\\", "/");
writeFileSync(
  join(stubDir, "supabase"),
  [
    "#!/usr/bin/env bash",
    "# stub CLI; the script calls `supabase --workdir <dir> <command> ...`",
    'echo "${*:3}" >>"$STUB_OUT/calls.log"',
    'if [ "$3 $4" = "config push" ]; then cp "$2/supabase/config.toml" "$STUB_OUT/pushed.toml"; fi',
    "",
  ].join("\n"),
);
chmodSync(join(stubDir, "supabase"), 0o755);
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

function deploy(customEmail: string | undefined) {
  rmSync(join(stubDir, "calls.log"), { force: true });
  rmSync(join(stubDir, "pushed.toml"), { force: true });
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${stubDir}${delimiter}${process.env[pathKey] ?? ""}`,
    STUB_OUT: out,
    SUPABASE_ACCESS_TOKEN: "test-token",
    SUPABASE_PROJECT_REF: "testref",
    SUPABASE_DB_PASSWORD: "test-password",
    SITE_URL: "https://staging.example.test",
    REDIRECT_URLS: "",
  };
  delete env.SUPABASE_POOLER_HOST;
  delete env.SUPABASE_CUSTOM_EMAIL;
  if (customEmail !== undefined) env.SUPABASE_CUSTOM_EMAIL = customEmail;
  const run = spawnSync(bash(), ["scripts/deploy-supabase.sh", "staging"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  expect(run.error).toBeUndefined();
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return {
    stdout: run.stdout,
    calls: lf(readFileSync(join(stubDir, "calls.log"), "utf8")),
    pushed: lf(readFileSync(join(stubDir, "pushed.toml"), "utf8")),
  };
}

describe("deploy-supabase.sh email templates (#121)", () => {
  const before = committed();

  it("the committed config sets the four templates (so the gate has something to drop)", () => {
    const headers = before.split("\n").filter((line) => templateHeader.test(line));
    expect(headers).toEqual([
      "[auth.email.template.confirmation]",
      "[auth.email.template.recovery]",
      "[auth.email.template.invite]",
      "[auth.email.template.email_change]",
    ]);
  });

  it.each([undefined, "", "false", "1"])(
    "SUPABASE_CUSTOM_EMAIL=%s: config push gets no template tables and everything else unchanged",
    (value) => {
      const { stdout, calls, pushed } = deploy(value);
      expect(calls).toMatch(/^config push --project-ref testref --yes$/m);
      expect(pushed.split("\n").some((line) => templateHeader.test(line))).toBe(false);
      const base = withoutTemplates(before);
      expect(base).toContain("[auth.hook.custom_access_token]");
      expect(pushed.startsWith(base)).toBe(true);
      expect(pushed.slice(base.length)).toMatch(/^\n# Appended by scripts\/deploy-supabase\.sh/);
      expect(stdout).toMatch(/::warning::staging: auth email templates not pushed/);
      expect(committed()).toBe(before);
    },
  );

  it("SUPABASE_CUSTOM_EMAIL=true: config push gets the templates unchanged", () => {
    const { stdout, calls, pushed } = deploy("true");
    expect(calls).toMatch(/^config push --project-ref testref --yes$/m);
    expect(pushed.startsWith(before)).toBe(true);
    expect(pushed.slice(before.length)).toMatch(/^\n# Appended by scripts\/deploy-supabase\.sh/);
    expect(stdout).not.toMatch(/email templates/);
    expect(committed()).toBe(before);
  });
});

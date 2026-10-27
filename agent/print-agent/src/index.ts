import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";

export const jobSchema = z.object({
  id: z.uuid(),
  payload_type: z.enum(["zpl", "pdf_url"]),
  payload: z.string().min(1),
  copies: z.number().int().min(1).max(100),
  address: z.string().min(1),
});
export type PrintJob = z.infer<typeof jobSchema>;
export function tcpAddress(address: string): { host: string; port: number } {
  const match = /^([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(address);
  const port = Number(match?.[2] ?? 9100);
  if (!match || port < 1 || port > 65535) throw new Error("Invalid printer address");
  return { host: match[1]!, port };
}
export async function sendZpl(address: string, payload: string, copies = 1): Promise<void> {
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) throw new Error("Invalid copies");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(tcpAddress(address));
    socket.setTimeout(15_000, () => socket.destroy(new Error("Printer timeout")));
    socket.once("error", reject);
    socket.once("connect", () => socket.end(payload.repeat(copies), "utf8"));
    socket.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}
const run = promisify(execFile);
export async function printPdf(job: PrintJob): Promise<void> {
  const url = new URL(job.payload);
  if (url.protocol !== "https:") throw new Error("PDF requires HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error("PDF download failed");
  const max = 20 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > max) throw new Error("PDF too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty PDF");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("PDF too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Not a PDF");
  const dir = await mkdtemp(join(tmpdir(), "filletry-print-"));
  try {
    const file = join(dir, "job.pdf");
    await writeFile(file, bytes, { mode: 0o600 });
    {
      if (process.platform === "win32")
        await run(
          process.env.SUMATRA_PDF_PATH ?? "SumatraPDF.exe",
          ["-print-to", job.address, "-print-settings", `${job.copies}x`, "-silent", file],
          { timeout: 60_000 },
        );
      else
        await run("lp", ["-d", job.address, "-n", String(job.copies), file], { timeout: 60_000 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export const deliver = (job: PrintJob) =>
  job.payload_type === "zpl" ? sendZpl(job.address, job.payload, job.copies) : printPdf(job);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Initial attempt plus three retries. Used separately for delivery and acknowledgement. */
export async function retry<T>(fn: () => Promise<T>, sleep = pause): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch {
      if (n === 3) throw new Error("Operation failed after retries");
      await sleep(1000 * 2 ** n);
    }
  }
}
/** Logs only allowlisted metadata; never exception messages, payloads, URLs or sessions. */
export async function fileLog(
  path: string,
  event:
    | "started"
    | "stopped"
    | "delivered"
    | "delivery_failed"
    | "queue_failed"
    | "heartbeat_failed"
    | "fatal",
  jobId?: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(
    path,
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...(jobId && z.uuid().safeParse(jobId).success ? { jobId } : {}),
    }) + "\n",
    { mode: 0o600 },
  );
}
/** Supabase storage adapter: refresh tokens survive service restarts. Protect directory ACLs on Windows. */
export function sessionStorage(path: string) {
  let pending = Promise.resolve();
  return {
    async getItem(key: string) {
      await pending;
      try {
        const data: unknown = JSON.parse(await readFile(path, "utf8"));
        return z.record(z.string(), z.string()).parse(data)[key] ?? null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async setItem(key: string, value: string) {
      pending = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        let data: Record<string, string> = {};
        try {
          data = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        data[key] = value;
        await writeFile(path, JSON.stringify(data), { mode: 0o600 });
      });
      await pending;
    },
    async removeItem() {
      await pending;
      await rm(path, { force: true });
    },
  };
}

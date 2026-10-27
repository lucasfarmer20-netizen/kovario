import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { toteTag } from "labels/zpl";
import { sendZpl, retry, sessionStorage, fileLog, tcpAddress } from "./index";
it("queued tote-tag bytes reach a fake TCP printer exactly, including copies", async () => {
  let received = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const zpl = toteTag({
      intakeNumber: "INT-0001",
      toteNo: 1,
      toteCount: 1,
      customer: "TCP fixture",
      date: "2026-10-26",
      lines: [],
    });
    await sendZpl(`127.0.0.1:${address.port}`, zpl, 2);
    expect(received).toBe(zpl.repeat(2));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
it("three retries back off and surface permanent failure", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await expect(
    retry(
      async () => {
        attempts++;
        throw new Error("sensitive underlying transport detail");
      },
      async (n) => {
        sleeps.push(n);
      },
    ),
  ).rejects.toThrow("Operation failed after retries");
  expect(attempts).toBe(4);
  expect(sleeps).toEqual([1000, 2000, 4000]);
});
it("default TCP 9100 and invalid port validation", () => {
  expect(tcpAddress("printer.local")).toEqual({ host: "printer.local", port: 9100 });
  expect(() => tcpAddress("x:99999")).toThrow();
});
it("session storage survives restart; logs contain only safe metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-test-"));
  try {
    const file = join(dir, "session.json");
    await sessionStorage(file).setItem("key", "session fixture");
    expect(await sessionStorage(file).getItem("key")).toBe("session fixture");
    await fileLog(join(dir, "agent.log"), "delivery_failed", "not-an-id");
    const log = JSON.parse(await readFile(join(dir, "agent.log"), "utf8"));
    expect(Object.keys(log)).toEqual(["at", "event"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

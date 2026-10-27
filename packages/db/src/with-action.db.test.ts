import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { filletryClaims } from "./claims";
import type { FilletryClient } from "./clients";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";
import type { Json } from "./types";
import { withAction } from "./with-action";

/** One atomic admin mutation: claims the id, inserts the site, stores the result. */
async function createSite(client: FilletryClient, id: string, name: string): Promise<Json> {
  const { data, error } = await client.rpc("admin_create_site", {
    p_client_action_id: id,
    p_name: name,
  });
  if (error) throw new Error(error.message);
  return data;
}

async function sitesNamed(org: TestOrg, name: string): Promise<number> {
  const { count } = await serviceRoleClient()
    .from("site")
    .select("id", { count: "exact", head: true })
    .eq("org_id", org.id)
    .eq("name", name);
  return count ?? -1;
}

describe("withAction against local Supabase", () => {
  let orgA: TestOrg;
  let orgB: TestOrg;
  let managerA: TestUser;
  let managerB: TestUser;

  beforeAll(async () => {
    orgA = await createOrg();
    orgB = await createOrg();
    managerA = await createUser(orgA, "manager");
    managerB = await createUser(orgB, "manager");
  });

  afterAll(async () => {
    await dropOrg(orgA);
    await dropOrg(orgB);
  });

  it("the access token hook stamps org_id and app_role", async () => {
    const { data } = await managerA.client.auth.getClaims();
    expect(filletryClaims(data?.claims)).toMatchObject({ orgId: orgA.id, appRole: "manager" });
    expect(data?.claims.role).toBe("authenticated");
  });

  it("replaying an action id returns the stored result without re-running", async () => {
    const id = randomUUID();
    const fn = vi.fn((actionId: string) => createSite(managerA.client, actionId, "Replay"));
    const first = await withAction(managerA.client, id, fn);
    const replay = await withAction(managerA.client, id, fn);
    expect(replay).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await sitesNamed(orgA, "Replay")).toBe(1);
  });

  it("a crash after the domain write committed never duplicates it on retry", async () => {
    const id = randomUUID();
    // The SQL function commits the site and its action_log result together, then the
    // response is lost (process/network failure before the caller sees it).
    const lostResponse = async (actionId: string): Promise<Json> => {
      await createSite(managerA.client, actionId, "Crash");
      throw new Error("network lost after commit");
    };
    await expect(withAction(managerA.client, id, lostResponse)).rejects.toThrow("network lost");

    // The client retries the same id: it gets the committed result, not a second site.
    const retry = vi.fn((actionId: string) => createSite(managerA.client, actionId, "Crash"));
    const result = await withAction(managerA.client, id, retry);
    expect(retry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ site_id: expect.any(String) });
    expect(await sitesNamed(orgA, "Crash")).toBe(1);

    // Even calling the SQL function again directly (no withAction pre-check) replays.
    expect(await createSite(managerA.client, id, "Crash")).toEqual(result);
    expect(await sitesNamed(orgA, "Crash")).toBe(1);
  });

  it("concurrent requests with the same id write once and return the same result", async () => {
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createSite(managerA.client, id, "Concurrent")),
    );
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await sitesNamed(orgA, "Concurrent")).toBe(1);
  });

  it("a failed action leaves nothing behind and can be retried with the same id", async () => {
    const id = randomUUID();
    await expect(createSite(managerA.client, id, "   ")).rejects.toThrow();
    const { data } = await managerA.client
      .from("action_log")
      .select("id")
      .eq("client_action_id", id);
    expect(data).toEqual([]);
    await expect(createSite(managerA.client, id, "Retried")).resolves.toMatchObject({
      site_id: expect.any(String),
    });
  });

  it("another org can neither read nor replay the action", async () => {
    const id = randomUUID();
    await withAction(managerA.client, id, (actionId) =>
      createSite(managerA.client, actionId, "Mine"),
    );
    const { data } = await managerB.client
      .from("action_log")
      .select("id")
      .eq("client_action_id", id);
    expect(data).toEqual([]);
    await expect(
      withAction(managerB.client, id, (actionId) =>
        createSite(managerB.client, actionId, "Theirs"),
      ),
    ).rejects.toThrow("already used");
    expect(await sitesNamed(orgB, "Theirs")).toBe(0);
  });
});

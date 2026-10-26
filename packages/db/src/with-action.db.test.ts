import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { kovarioClaims } from "./claims";
import {
  createOrg,
  createUser,
  dropOrg,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";
import { withAction } from "./with-action";

describe("withAction against local Supabase", () => {
  let orgA: TestOrg;
  let orgB: TestOrg;
  let userA: TestUser;
  let userB: TestUser;

  beforeAll(async () => {
    orgA = await createOrg();
    orgB = await createOrg();
    userA = await createUser(orgA, "staff");
    userB = await createUser(orgB, "staff");
  });

  afterAll(async () => {
    await dropOrg(orgA);
    await dropOrg(orgB);
  });

  it("the access token hook stamps org_id and app_role", async () => {
    const { data } = await userA.client.auth.getClaims();
    expect(kovarioClaims(data?.claims)).toMatchObject({ orgId: orgA.id, appRole: "staff" });
    expect(data?.claims.role).toBe("authenticated");
  });

  it("replaying an action id returns the stored result", async () => {
    const id = randomUUID();
    const fn = vi.fn(async () => ({ number: "INT-0042" }));
    const first = await withAction(userA.client, id, fn, {
      action: "test.replay",
      input: { n: 1 },
    });
    const replay = await withAction(userA.client, id, fn, {
      action: "test.replay",
      input: { n: 1 },
    });
    expect(replay).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);

    const { data } = await userA.client
      .from("action_log")
      .select("result, completed_at")
      .eq("client_action_id", id);
    expect(data).toEqual([{ result: { number: "INT-0042" }, completed_at: expect.any(String) }]);
  });

  it("another org can neither read nor replay the action", async () => {
    const id = randomUUID();
    await withAction(userA.client, id, async () => "secret-result", { action: "test.cross" });
    const { data } = await userB.client.from("action_log").select("id").eq("client_action_id", id);
    expect(data).toEqual([]);
    await expect(
      withAction(userB.client, id, async () => "other", { action: "test.cross" }),
    ).rejects.toThrow();
  });
});

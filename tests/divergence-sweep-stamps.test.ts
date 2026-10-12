import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearReplayedDivergences,
  listNativeWriteFailures,
  markDivergencesForSweep,
  recordNativeWriteFailure,
  releaseDivergenceSweepStamps,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import { createEnv, seedDirectory } from "./helpers";

describe("divergence sweep stamp ownership and upgrade", () => {
  let env: PocEnv;
  beforeEach(async () => {
    env = await createEnv();
  });

  async function record(directoryId: string, key: string, method = "PUT") {
    await recordNativeWriteFailure(env.DB, {
      directory_id: directoryId,
      resource_type: "Users",
      resource_key: key,
      method,
      native_status: 500,
      detail: "WorkOS committed; native did not",
    });
  }

  it("releases only its own directory and token, preserving a successor's stamp and live failures", async () => {
    const directory = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    await record(directory.id, "old-gap");
    await record(other.id, "other-gap");
    await markDivergencesForSweep(env.DB, directory.id, "run-a");
    await markDivergencesForSweep(env.DB, other.id, "run-a");
    // A successor that slipped past the expired lease cannot steal run A's
    // stamps; run A's later release cannot remove the successor's stamps either.
    await record(directory.id, "successor-gap");
    await markDivergencesForSweep(env.DB, directory.id, "run-b");
    await record(directory.id, "live-gap");

    await releaseDivergenceSweepStamps(env.DB, directory.id, "run-a");
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    expect(rows.find((row) => row.resource_key === "old-gap")).toMatchObject({ sweep_token: null });
    expect(rows.find((row) => row.resource_key === "successor-gap")).toMatchObject({
      sweep_token: "run-b",
    });
    expect(rows.find((row) => row.resource_key === "live-gap")).toMatchObject({
      sweep_token: null,
    });
    expect(await listNativeWriteFailures(env.DB, other.id)).toMatchObject([
      { resource_key: "other-gap", sweep_token: "run-a" },
    ]);

    await clearReplayedDivergences(env.DB, directory.id, "run-a");
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(rows);
    await clearReplayedDivergences(env.DB, directory.id, "run-b");
    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key).sort(),
    ).toEqual(["live-gap", "old-gap"]);
  });

  it.each([
    "../migrations/0016_release_divergence_sweep_stamps.sql",
    "../migrations/postgres/0010_release_divergence_sweep_stamps.sql",
  ])("migration %s clears existing stamps without changing or deleting gaps", async (path) => {
    const directory = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    await record(directory.id, "put-gap");
    await record(directory.id, "delete-gap", "DELETE");
    await record(other.id, "other-gap");
    await markDivergencesForSweep(env.DB, directory.id, "dirty-run");
    await markDivergencesForSweep(env.DB, other.id, "in-flight-run");
    await record(directory.id, "live-gap");
    const expected = (await listNativeWriteFailures(env.DB, directory.id)).map((row) => ({
      ...row,
      sweep_token: null,
    }));
    const expectedOther = (await listNativeWriteFailures(env.DB, other.id)).map((row) => ({
      ...row,
      sweep_token: null,
    }));

    await env.DB.prepare(readFileSync(new URL(path, import.meta.url), "utf8")).run();
    await clearReplayedDivergences(env.DB, other.id, "in-flight-run");

    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(expected);
    expect(await listNativeWriteFailures(env.DB, other.id)).toEqual(expectedOther);
  });
});

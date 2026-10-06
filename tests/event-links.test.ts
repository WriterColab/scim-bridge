import { describe, expect, it } from "vitest";
import { deleteMapping, upsertMapping } from "../workers/shared/db";
import {
  bindEventLink,
  getEventLink,
  getEventLinkByNativeId,
  type EventLink,
} from "../workers/shared/event-links";
import { createEnv, seedDirectory } from "./helpers";

function link(directoryId: string, changes: Partial<EventLink> = {}): EventLink {
  return {
    directory_id: directoryId,
    resource_type: "Users",
    dsync_id: "directory_user_ada",
    native_id: "18",
    workos_id: "workos-ada",
    ...changes,
  };
}

describe("immutable Directory Sync event links", () => {
  it("does not infer a link from a SCIM mapping alone", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "18",
      workos_id: "workos-ada",
      strategy: "fallback-post",
    });

    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toBeNull();
  });

  it("persists the full pair and permits an identical retry", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const expected = link(directory.id);

    await bindEventLink(env.DB, expected);
    await bindEventLink(env.DB, expected);

    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toEqual(
      expected,
    );
  });

  for (const changed of [
    { native_id: "19" },
    { workos_id: "workos-new" },
    { native_id: "19", workos_id: "workos-new" },
  ]) {
    it(`refuses to change an established pair (${Object.keys(changed).join(", ")})`, async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      const expected = link(directory.id);
      await bindEventLink(env.DB, expected);

      await expect(bindEventLink(env.DB, link(directory.id, changed))).rejects.toThrow();
      expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toEqual(
        expected,
      );
    });
  }

  for (const shared of ["native_id", "workos_id"] as const) {
    it(`atomically admits only one Directory Sync owner of a ${shared}`, async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      const contenders = [
        link(directory.id, { dsync_id: "directory_user_first" }),
        link(directory.id, {
          dsync_id: "directory_user_second",
          native_id: shared === "native_id" ? "18" : "19",
          workos_id: shared === "workos_id" ? "workos-ada" : "workos-other",
        }),
      ];

      const results = await Promise.allSettled(
        contenders.map((entry) => bindEventLink(env.DB, entry)),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      for (let index = 0; index < contenders.length; index++) {
        const entry = contenders[index];
        expect(await getEventLink(env.DB, directory.id, "Users", entry.dsync_id)).toEqual(
          results[index].status === "fulfilled" ? entry : null,
        );
      }
    });
  }

  it("admits both concurrent retries of the same immutable pair", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const expected = link(directory.id);

    await Promise.all([bindEventLink(env.DB, expected), bindEventLink(env.DB, expected)]);

    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toEqual(
      expected,
    );
  });

  it("keeps ownership scoped to the directory and resource type", async () => {
    const env = await createEnv();
    const first = await seedDirectory(env.DB);
    const second = await seedDirectory(env.DB);
    const entries = [
      link(first.id),
      link(second.id, { dsync_id: "directory_user_other", workos_id: "workos-other" }),
      link(first.id, {
        resource_type: "Groups",
        dsync_id: "directory_group_ada",
        workos_id: "workos-group",
      }),
    ];

    await Promise.all(entries.map((entry) => bindEventLink(env.DB, entry)));

    for (const entry of entries) {
      expect(
        await getEventLink(env.DB, entry.directory_id, entry.resource_type, entry.dsync_id),
      ).toEqual(entry);
      expect(
        await getEventLinkByNativeId(
          env.DB,
          entry.directory_id,
          entry.resource_type,
          entry.native_id,
        ),
      ).toEqual(entry);
    }
    expect(await getEventLinkByNativeId(env.DB, first.id, "Users", "absent")).toBeNull();
  });

  it("retains the association after its SCIM mapping is pruned", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const expected = link(directory.id);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "18",
      workos_id: "workos-ada",
      strategy: "fallback-post",
    });
    await bindEventLink(env.DB, expected);

    await deleteMapping(env.DB, directory.id, "Users", "18");

    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toEqual(
      expected,
    );
    expect(await getEventLinkByNativeId(env.DB, directory.id, "Users", "18")).toEqual(expected);
    await expect(
      bindEventLink(
        env.DB,
        link(directory.id, { dsync_id: "directory_user_recreated", workos_id: "workos-new" }),
      ),
    ).rejects.toThrow();
    expect(
      await getEventLink(env.DB, directory.id, "Users", "directory_user_recreated"),
    ).toBeNull();
  });

  it("removes event links only when their directory is deleted", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    await bindEventLink(env.DB, link(directory.id));

    await env.DB.prepare("DELETE FROM scim_directories WHERE id = ?").bind(directory.id).run();

    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toBeNull();
    await expect(bindEventLink(env.DB, link(directory.id))).rejects.toThrow();
  });

  for (const field of ["dsync_id", "native_id", "workos_id"] as const) {
    it(`does not bind an empty ${field}`, async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      await expect(bindEventLink(env.DB, link(directory.id, { [field]: "" }))).rejects.toThrow();
      expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_ada")).toBeNull();
    });
  }
});

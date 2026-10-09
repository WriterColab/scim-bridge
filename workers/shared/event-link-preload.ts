import type { Datastore } from "./datastore";
import type { Directory } from "./types";
import { EventMappingError, learnEventLink, type EventMappingReason } from "./event-mapping";
import { isRecord } from "./scim";

export interface GroupEventLinkSummary {
  total: number;
  newly_linked: number;
  already_linked: number;
  gone: number;
  failed: { dsync_id: string; name: string; reason: EventMappingReason }[];
  /** A listing/config failure means coverage is unknown, even with no failed rows. */
  reason?: EventMappingReason;
  skipped?: "bundled_simulator";
}

export interface GroupEventLinkOptions {
  apiKey?: string;
  bundledSimulator?: boolean;
}

export function emptyGroupEventLinkSummary(): GroupEventLinkSummary {
  return { total: 0, newly_linked: 0, already_linked: 0, gone: 0, failed: [] };
}

function reasonFor(error: unknown): EventMappingReason {
  return error instanceof EventMappingError ? error.reason : "identity_unconfirmed";
}

/**
 * Learn while groups still exist: a deletion can only use a retained link.
 * A partial listing never proves coverage. Only fixed reasons reach the panel,
 * so neither upstream error bodies nor credentials leak into the summary.
 */
export async function preloadGroupEventLinks(
  db: Datastore,
  directory: Directory,
  apiKey: string | undefined,
): Promise<GroupEventLinkSummary> {
  const summary = emptyGroupEventLinkSummary();
  if (!apiKey) return { ...summary, reason: "learning_disabled" };
  if (!directory.workos_directory_id) return { ...summary, reason: "directory_unconfigured" };
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | null = null;
  try {
    do {
      const url = new URL("https://api.workos.com/directory_groups");
      url.searchParams.set("directory", directory.workos_directory_id);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        throw new EventMappingError("upstream_unavailable");
      }
      if (!response.ok)
        throw new EventMappingError(
          response.status >= 500 ? "upstream_unavailable" : "identity_unconfirmed",
        );
      let page: unknown;
      try {
        page = await response.json();
      } catch (error) {
        throw new EventMappingError(
          error instanceof SyntaxError ? "identity_unconfirmed" : "upstream_unavailable",
        );
      }
      if (!isRecord(page) || !Array.isArray(page.data) || !isRecord(page.list_metadata))
        throw new EventMappingError("identity_unconfirmed");
      const cursor = page.list_metadata.after;
      if (cursor !== null && (typeof cursor !== "string" || !cursor || seenCursors.has(cursor)))
        throw new EventMappingError("identity_unconfirmed");
      after = cursor as string | null;
      if (after) seenCursors.add(after);
      const groups: Record<string, unknown>[] = [];
      for (const group of page.data) {
        if (
          !isRecord(group) ||
          typeof group.id !== "string" ||
          !group.id.startsWith("directory_group_") ||
          group.object !== "directory_group" ||
          group.directory_id !== directory.workos_directory_id
        )
          throw new EventMappingError("identity_unconfirmed");
        if (seenIds.has(group.id)) continue;
        seenIds.add(group.id);
        groups.push(group);
      }
      summary.total += groups.length;
      // Four workers bound upstream pressure without serializing a large directory.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, groups.length) }, async () => {
          while (next < groups.length) {
            const group = groups[next++];
            try {
              const learned = await learnEventLink(db, directory, "Groups", group, apiKey);
              if (learned.alreadyLinked) summary.already_linked++;
              else summary.newly_linked++;
            } catch (error) {
              const reason = reasonFor(error);
              // A group removed during this run is no longer a live cutover target.
              // This never authorizes skipping a later unresolved delete event.
              if (reason === "dsync_resource_gone") summary.gone++;
              else
                summary.failed.push({
                  dsync_id: group.id as string,
                  name: typeof group.name === "string" ? group.name : "",
                  reason,
                });
            }
          }
        }),
      );
    } while (after);
  } catch (error) {
    summary.reason = reasonFor(error);
  }
  summary.failed.sort((a, b) => a.dsync_id.localeCompare(b.dsync_id));
  return summary;
}

/** Automatic steps are best effort and must never change the replay result. */
export async function preloadForOperation(
  db: Datastore,
  directory: Directory,
  options: GroupEventLinkOptions = {},
): Promise<GroupEventLinkSummary> {
  if (options.bundledSimulator)
    return { ...emptyGroupEventLinkSummary(), skipped: "bundled_simulator" };
  return preloadGroupEventLinks(db, directory, options.apiKey);
}

export function groupEventLinksReady(summary: GroupEventLinkSummary): boolean {
  return !summary.reason && summary.failed.length === 0;
}

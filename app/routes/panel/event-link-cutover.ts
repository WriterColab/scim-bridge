import type { Datastore } from "../../../workers/shared/datastore";
import type { Directory, Mode } from "../../../workers/shared/types";
import { demoDirectoryId } from "../../../workers/shared/client-tokens";
import { setDirectoryMode } from "../../../workers/shared/db";
import {
  groupEventLinksReady,
  preloadForOperation,
  type GroupEventLinkOptions,
  type GroupEventLinkSummary,
} from "../../../workers/shared/event-link-preload";

/** Demo bypass applies only to the simulator directory on our loopback mount.
 * DEMO_MODE alone must never exempt a real imported WorkOS directory. */
export async function panelEventLinkOptions(
  db: Datastore,
  directory: Directory,
  demoMode: boolean,
): Promise<GroupEventLinkOptions> {
  let bundledSimulator = false;
  if (demoMode && directory.id === (await demoDirectoryId(db))) {
    try {
      const url = new URL(directory.workos_url);
      bundledSimulator =
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.replace(/\/$/, "") === "/__demo/native/mock-workos/scim/v2";
    } catch {
      /* An invalid endpoint is never a simulator exemption. */
    }
  }
  return { apiKey: process.env.WORKOS_API_KEY?.trim() || undefined, bundledSimulator };
}

export interface CutoverResult {
  error?: string;
  eventLinks?: GroupEventLinkSummary;
}

/** All panel mode writers share this gate; leaving cutover never needs WorkOS. */
export async function setPanelDirectoryMode(
  db: Datastore,
  directory: Directory,
  mode: Mode,
  options: GroupEventLinkOptions,
  override: boolean,
): Promise<CutoverResult> {
  let eventLinks: GroupEventLinkSummary | undefined;
  if (mode === "workos-only" && directory.mode !== "workos-only") {
    eventLinks = await preloadForOperation(db, directory, options);
    if (!groupEventLinksReady(eventLinks) && !override) {
      return {
        error:
          "Cutover refused: event links are incomplete. Repair the failures and retry, or explicitly confirm Switch without links (emergency override).",
        eventLinks,
      };
    }
    if (override) {
      // No credentials or upstream messages in the audit warning.
      console.warn(
        `WARNING: Switch without links override used for directory ${directory.id}; ` +
          `${eventLinks.failed.length} failed groups, reason=${eventLinks.reason ?? "none"}.`,
      );
    }
  }
  await setDirectoryMode(db, directory.id, mode);
  return eventLinks ? { eventLinks } : {};
}

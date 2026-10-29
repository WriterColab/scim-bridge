import { deleteConfig, getConfig, setConfig } from "../shared/db";
import type { Datastore } from "../shared/datastore";
import { processDsyncEvent, recordEvent } from "./listener";
import { eventsHttpFetch } from "../shared/http-clients";

/**
 * The Events API polling transport: the ordered alternative to webhooks.
 *
 * WorkOS webhooks carry no ordering guarantee, and the listener's timestamp
 * ledger can only order events whose `created_at` differ — a stale
 * `dsync.user.deleted` delivered 31s late once destroyed state a newer event
 * had established. `GET /events` returns the same envelopes **in order** behind
 * a cursor, so applying them in returned order needs no timestamps at all.
 *
 * Every event still flows through `processDsyncEvent` — the same
 * handle-vs-ignore instruction, replay guards, dedup and event log as a webhook
 * delivery — so running both transports at once only costs "skipped duplicate"
 * rows, never a double apply.
 *
 * The API key that authenticates this endpoint is environment-wide — a broader
 * credential than anything else the listener holds — which is why it comes
 * from the environment (WORKOS_API_KEY) first. The demo panel may store one
 * instead (encrypted at rest — see events-transport.ts), and the env var
 * always wins over the stored copy.
 */

/** Where the cursor survives a restart: the id of the last event whose
 *  processing completed, so a new process resumes without gaps or replays. */
export const EVENTS_CURSOR_KEY = "native.events_cursor";

/** Consecutive-failure state for the event the cursor is waiting on, as JSON
 *  `{ "id": "evt_…", "count": n }`. Persisted beside the cursor so a restart
 *  does not hand a poison event a fresh attempt budget. */
export const EVENTS_RETRY_KEY = "native.events_retry";

/**
 * How many times a failing event is attempted before the poller gives up and
 * moves the cursor past it. Retrying at all lets a transient failure (a lock,
 * a restart mid-write) repair itself; a bound is what stops a deterministic
 * failure from blocking every event behind it forever — with webhooks the same
 * event would exhaust WorkOS's redelivery schedule, so a bounded budget here is
 * the same contract. Abandonment is recorded loudly in listener_events; the
 * repair for the skipped event is a Reconcile from WorkOS.
 */
export const MAX_EVENT_ATTEMPTS = 5;

const DEFAULT_EVENTS_URL = "https://api.workos.com";
const DEFAULT_LIMIT = 100;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** The dsync.* events the listener has handlers (or deliberate no-ops) for —
 *  the `events` filter keeps everything else out of the response. */
export const DSYNC_EVENT_TYPES = [
  "dsync.activated",
  "dsync.deleted",
  "dsync.user.created",
  "dsync.user.updated",
  "dsync.user.deleted",
  "dsync.group.created",
  "dsync.group.updated",
  "dsync.group.deleted",
  "dsync.group.user_added",
  "dsync.group.user_removed",
] as const;

/** How long a single events request may take before it is aborted. A
 *  black-holed endpoint must cost one failed tick (logged, retried next
 *  tick), never a poll that hangs forever. */
export const EVENTS_FETCH_TIMEOUT_MS = 30_000;

export interface EventsPollerOptions {
  /** The environment's API key, from WORKOS_API_KEY. */
  apiKey: string;
  /** Base URL of the Events API; the demo points this at the bundled mock. */
  baseUrl?: string;
  /** Page size per request. */
  limit?: number;
  /** Per-request abort budget; defaults to EVENTS_FETCH_TIMEOUT_MS. */
  fetchTimeoutMs?: number;
}

interface EventsPage {
  data?: unknown[];
  list_metadata?: { after?: string | null };
}

/**
 * Fetch and apply every event newer than the persisted cursor, strictly in
 * returned order, paging until the API reports no more. Returns how many events
 * were processed. Throws on a fetch or API failure — the loop in
 * `startEventsPoller` turns that into a logged retry.
 */
export async function pollDsyncEventsOnce(
  db: Datastore,
  options: EventsPollerOptions,
): Promise<{ processed: number }> {
  const base = (options.baseUrl ?? DEFAULT_EVENTS_URL).replace(/\/+$/, "");
  const limit = options.limit ?? DEFAULT_LIMIT;
  let cursor = await getConfig(db, EVENTS_CURSOR_KEY);
  let retry = await readRetryState(db);
  let processed = 0;

  for (;;) {
    const url = new URL(`${base}/events`);
    for (const type of DSYNC_EVENT_TYPES) url.searchParams.append("events[]", type);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("after", cursor);

    const response = await eventsHttpFetch(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.fetchTimeoutMs ?? EVENTS_FETCH_TIMEOUT_MS),
    });
    if (response.status === 400 && cursor) {
      await response.body?.cancel();
      // The API no longer recognises the cursor — real WorkOS retains events
      // for a bounded window, so a poller that was down long enough comes back
      // holding an id the API has forgotten. Staying dead is the one wrong
      // answer: drop the cursor and replay the retained history, which the
      // event-id dedup absorbs where it overlaps what was already applied.
      console.warn(
        `events poller: the API rejected cursor ${cursor} (likely expired); ` +
          "clearing it and replaying the retained event history",
      );
      await deleteConfig(db, EVENTS_CURSOR_KEY);
      cursor = null;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`events API answered ${response.status} for GET ${base}/events`);
    }
    const page = (await response.json()) as EventsPage;
    const events = Array.isArray(page.data) ? page.data : [];

    // Ordering is the whole point of this transport: each event is fully
    // applied before the next is looked at, and the page is walked front to
    // back exactly as the API returned it.
    let lastProcessedId: string | null = cursor;
    const advanceCursor = async (id: string | null): Promise<void> => {
      if (id && id !== cursor) await setConfig(db, EVENTS_CURSOR_KEY, id);
    };
    for (const event of events) {
      const envelope =
        event && typeof event === "object" && !Array.isArray(event)
          ? (event as Record<string, unknown>)
          : null;
      const id = typeof envelope?.id === "string" && envelope.id ? envelope.id : null;
      const isRetry = retry !== null && id !== null && retry.id === id;
      // Repeats of a failure already in the log stay out of it — one row per
      // 5s tick would bury the log — so only the first attempt records.
      const outcome = await processDsyncEvent(db, envelope, undefined, {
        recordHandlerError: !isRetry,
      });
      if (!outcome.handlerError) {
        if (isRetry) retry = await clearRetryState(db);
        processed += 1;
        if (id) lastProcessedId = id;
        continue;
      }

      const attempts = isRetry && retry ? retry.count + 1 : 1;
      if (id && attempts < MAX_EVENT_ATTEMPTS) {
        // The failed event stays ahead of the cursor so the next poll re-reads
        // and retries it; everything already processed moves behind it. The
        // replays that re-read causes are absorbed by the event-id dedup.
        retry = { id, count: attempts };
        await setConfig(db, EVENTS_RETRY_KEY, JSON.stringify(retry));
        await advanceCursor(lastProcessedId);
        return { processed };
      }
      // The attempt budget is spent (or the event has no id to track a budget
      // under): give up LOUDLY and move on, or this one event blocks every
      // event behind it forever. The record is greppable and names the repair.
      retry = await clearRetryState(db);
      await recordEvent(db, {
        eventId: id,
        eventType:
          typeof envelope?.event === "string" && envelope.event ? envelope.event : "unknown",
        idpId: null,
        action: "ignored",
        detail:
          `poller abandoned event ${id ?? "<no id>"} after ${attempts} attempts — ` +
          "the event was NOT applied; run Reconcile from WorkOS to repair the resource",
        payload: JSON.stringify(envelope),
      });
      if (id) lastProcessedId = id;
    }
    await advanceCursor(lastProcessedId);
    cursor = lastProcessedId;

    // A null `after` is how the API says the log is exhausted.
    if (!page.list_metadata?.after || events.length === 0) return { processed };
  }
}

interface RetryState {
  id: string;
  count: number;
}

async function readRetryState(db: Datastore): Promise<RetryState | null> {
  const raw = await getConfig(db, EVENTS_RETRY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; count?: unknown };
    if (typeof parsed.id === "string" && typeof parsed.count === "number") {
      return { id: parsed.id, count: parsed.count };
    }
  } catch {
    // fall through: a corrupt value reads as "no retry in progress"
  }
  return null;
}

async function clearRetryState(db: Datastore): Promise<null> {
  await deleteConfig(db, EVENTS_RETRY_KEY);
  return null;
}

export interface EventsPoller {
  stop(): void;
  /** Settles when the immediate first poll finishes (it never rejects — the
   *  tick logs failures). Nothing on a request path awaits it: a first poll
   *  drains a backlog over a network nobody controls, so boot and the panel
   *  must return while it runs. Tests await it for determinism. */
  firstPoll: Promise<void>;
}

/**
 * Poll on an interval, forever. One poll in flight at a time — a slow page must
 * not be overtaken by the next tick, or events would apply out of order — and a
 * failed poll is logged and retried next tick rather than allowed to bring the
 * process down with it.
 */
export function startEventsPoller(
  db: Datastore,
  options: EventsPollerOptions & {
    intervalMs?: number;
    /** Called after each poll that completed without throwing. */
    onSuccess?: () => void;
    /** Called with the message of each poll that threw (after it is logged). */
    onError?: (message: string) => void;
  },
): EventsPoller {
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pollDsyncEventsOnce(db, options);
      options.onSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`events poller: ${message}; retrying next tick`);
      options.onError?.(message);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  // Never the reason the process can't exit (Node timers hold the loop open).
  timer.unref?.();
  return {
    firstPoll: tick(),
    stop() {
      clearInterval(timer);
    },
  };
}

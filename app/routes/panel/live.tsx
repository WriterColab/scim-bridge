import { panelEventLinkOptions, setPanelDirectoryMode } from "./event-link-cutover";
import { EventLinkResult, SwitchWithoutLinks } from "./event-link-result";
import type { BackfillSummary } from "../../../workers/shared/types";
import type { GroupEventLinkSummary } from "../../../workers/shared/event-link-preload";
import type { Route } from "./+types/live";

import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { datastoreContext, demoModeContext } from "../../context";
import type { Directory, ListenerEvent, Mode } from "../../../workers/shared/types";
import { MODES } from "../../../workers/shared/types";
import {
  clearNativeDirectory,
  getDirectoryById,
  listDirectories,
  withDatastoreRetry,
} from "../../../workers/shared/db";
import { runBackfill } from "../../../workers/shared/backfill";
import { joinScimUrl } from "../../../workers/shared/scim";
import { callIdpSimulator } from "./idp-simulator";
import { FlowRail } from "./flow-rail";
import { readUserSnapshot, type EndpointCount } from "./user-count";
import { FieldLabel } from "./ui";
import {
  reconcileGroups,
  reconcileUsers,
  tombstoneSummary,
  workosGroupRows,
  type DirRow,
  type GroupMemberReconRow,
  type GroupRow,
  type Presence,
} from "./reconcile";
import {
  Box,
  Callout,
  Card,
  Code,
  Flex,
  Grid,
  Heading,
  Select,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import * as AlertDialog from "../../ui/alert-dialog";
import * as Dialog from "../../ui/dialog";
import * as EmptyState from "../../ui/empty-state";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";

const DEFAULT_INTERVAL_MS = 4000;

const INTERVAL_OPTIONS = [
  { value: "1000", label: "Every 1 second" },
  { value: "2000", label: "Every 2 seconds" },
  { value: "4000", label: "Every 4 seconds" },
  { value: "8000", label: "Every 8 seconds" },
];

const ACTION_BADGE_COLORS = {
  applied: "green",
  skipped: "gray",
  ignored: "yellow",
} as const;

const REFRESH_MS = 3000;

interface ScimMember {
  value?: string;
  display?: string;
}

interface ScimResource {
  id?: string;
  userName?: string;
  displayName?: string;
  active?: boolean;
  members?: ScimMember[];
}

/** Read the WorkOS side live over SCIM, so this works whether the directory
 *  points at the local mock or a real WorkOS directory. */
async function fetchWorkosDirectory(
  url: string,
  token: string,
): Promise<EndpointCount & { users: DirRow[]; groups: GroupRow[] }> {
  const unavailable = { reachable: false, count: null, truncated: false, users: [], groups: [] };
  if (!url || !token) return unavailable;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    // joinScimUrl + redirect:"manual": a saved base can neither fold the path into
    // a query nor bounce this bearer-token read to an internal/metadata host.
    const [snapshot, gRes] = await Promise.all([
      readUserSnapshot(url, token),
      fetch(`${joinScimUrl(url, "/Groups")}?count=200`, { headers, redirect: "manual" }),
    ]);
    if (!snapshot.reachable || !gRes.ok) return unavailable;
    const gBody = (await gRes.json()) as { Resources?: ScimResource[] };
    const users = snapshot.users.map((r) => ({
      name: r.userName ?? "",
      active: r.active === false ? 0 : 1,
    }));
    // A group's members arrive as SCIM ids, and are resolved to userNames against
    // the /Users listing this same call fetched — that resolution is what lets
    // `reconcileGroups` ask whether a member is one of WorkOS's retained inactive
    // records, so it lives in the module the test can reach.
    const groups = workosGroupRows(gBody.Resources ?? [], snapshot.users);
    return { ...snapshot, users, groups };
  } catch {
    return unavailable;
  }
}

/** Empty the WorkOS directory the directory points at, over SCIM — so it
 *  works for the local mock or a real directory. Groups first, then users. */
async function cleanWorkosDirectory(
  url: string,
  token: string,
): Promise<{ ok: boolean; deleted: number; failed: number }> {
  if (!url || !token) return { ok: false, deleted: 0, failed: 0 };
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const [uRes, gRes] = await Promise.all([
      fetch(`${joinScimUrl(url, "/Users")}?count=200`, { headers, redirect: "manual" }),
      fetch(`${joinScimUrl(url, "/Groups")}?count=200`, { headers, redirect: "manual" }),
    ]);
    if (!uRes.ok || !gRes.ok) return { ok: false, deleted: 0, failed: 0 };
    const uBody = (await uRes.json()) as { Resources?: ScimResource[] };
    const gBody = (await gRes.json()) as { Resources?: ScimResource[] };
    const targets: [string, string][] = [
      ...(gBody.Resources ?? []).map((r) => ["Groups", r.id] as [string, string | undefined]),
      ...(uBody.Resources ?? []).map((r) => ["Users", r.id] as [string, string | undefined]),
    ].filter((t): t is [string, string] => typeof t[1] === "string");
    let deleted = 0;
    let failed = 0;
    for (const [kind, id] of targets) {
      const res = await fetch(joinScimUrl(url, `/${kind}/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers,
        redirect: "manual",
      });
      if (res.ok || res.status === 404) deleted += 1;
      else failed += 1;
    }
    return { ok: true, deleted, failed };
  } catch {
    return { ok: false, deleted: 0, failed: 0 };
  }
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.get(datastoreContext);
  const directories = await listDirectories(db);
  const directory = directories[0] ?? null;
  if (!directory) {
    return { directory: null } as const;
  }

  const [nativeU, idpU, nativeG, nativeGM, idpG, idpGM, workos, auto, events] = await Promise.all([
    withDatastoreRetry(() =>
      db.prepare("SELECT user_name AS name, active FROM native_users").all<DirRow>(),
    ),
    withDatastoreRetry(() =>
      db
        .prepare("SELECT user_name AS name, active FROM idp_users WHERE directory_id = ?")
        .bind(directory.id)
        .all<DirRow>(),
    ),
    // Groups and their membership edges are read separately and folded together
    // in `foldGroupMembers`: the comparison is by member identity now, and a portable
    // per-group list is a second query rather than a dialect-specific aggregate.
    withDatastoreRetry(() =>
      db
        .prepare("SELECT display_name AS name FROM native_groups ORDER BY display_name, id")
        .all<GroupNameRow>(),
    ),
    withDatastoreRetry(() =>
      db
        .prepare(
          // COALESCE, not an inner join: an edge whose user row is missing was
          // counted before this change and still is, under its raw id.
          "SELECT g.display_name AS name, COALESCE(u.user_name, m.user_id) AS member " +
            "FROM native_groups g JOIN native_group_members m ON m.group_id = g.id " +
            "LEFT JOIN native_users u ON u.id = m.user_id " +
            "ORDER BY g.display_name, member",
        )
        .all<GroupMemberQueryRow>(),
    ),
    withDatastoreRetry(() =>
      db
        .prepare(
          "SELECT display_name AS name FROM idp_groups WHERE directory_id = ? " +
            "ORDER BY display_name, id",
        )
        .bind(directory.id)
        .all<GroupNameRow>(),
    ),
    withDatastoreRetry(() =>
      db
        .prepare(
          "SELECT g.display_name AS name, COALESCE(u.user_name, m.user_id) AS member " +
            "FROM idp_groups g JOIN idp_group_members m ON m.group_id = g.id " +
            "LEFT JOIN idp_users u ON u.id = m.user_id " +
            "WHERE g.directory_id = ? ORDER BY g.display_name, member",
        )
        .bind(directory.id)
        .all<GroupMemberQueryRow>(),
    ),
    fetchWorkosDirectory(directory.workos_url, directory.workos_token),
    withDatastoreRetry(() =>
      db
        .prepare(
          "SELECT running, interval_ms, tick_count FROM idp_auto_state WHERE directory_id = ?",
        )
        .bind(directory.id)
        .first<AutoStateRow>(),
    ),
    withDatastoreRetry(() =>
      db.prepare("SELECT * FROM listener_events ORDER BY id DESC LIMIT 25").all<ListenerEvent>(),
    ),
  ]);

  return {
    directory: { id: directory.id, name: directory.name, mode: directory.mode },
    workosReachable: workos.reachable,
    workosCount: {
      reachable: workos.reachable,
      count: workos.count,
      truncated: workos.truncated,
    },
    workosConfigured: directory.workos_url !== "",
    workosIsMock: directory.workos_url.includes("/mock-workos/"),
    auto: auto ?? null,
    events: events.results,
    users: { native: nativeU.results, workos: workos.users, idp: idpU.results },
    groups: {
      native: foldGroupMembers(nativeG.results, nativeGM.results),
      workos: workos.groups,
      idp: foldGroupMembers(idpG.results, idpGM.results),
    },
  } as const;
}

interface GroupNameRow {
  name: string;
}
interface GroupMemberQueryRow {
  name: string;
  member: string;
}

/** Fold a group listing and a flat (group, member) listing into one row per group. */
function foldGroupMembers(groups: GroupNameRow[], members: GroupMemberQueryRow[]): GroupRow[] {
  const byName = new Map<string, string[]>(groups.map((g) => [g.name, []]));
  for (const m of members) byName.get(m.name)?.push(m.member);
  return [...byName].map(([name, groupMembers]) => ({ name, members: groupMembers }));
}

interface AutoStateRow {
  running: number;
  interval_ms: number;
  tick_count: number;
}

export async function action({ context, request }: Route.ActionArgs) {
  const db = context.get(datastoreContext);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "reset-native") {
    await clearNativeDirectory(db);
    return {};
  }

  const directoryId = String(form.get("directoryId") ?? "");
  const directory = directoryId ? await getDirectoryById(db, directoryId) : null;
  if (!directory) {
    return { error: "No directory exists yet — create one on the Directories tab first." };
  }

  // --- IdP simulator controls (forwarded to the simulator worker) ---
  if (intent === "idp-seed") {
    const r = await callIdpSimulator(db, "seed", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-reset") {
    const r = await callIdpSimulator(db, "reset", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-auto-start") {
    const intervalMs = Number(form.get("intervalMs")) || DEFAULT_INTERVAL_MS;
    const r = await callIdpSimulator(db, "auto/start", {
      directoryId: directory.id,
      intervalMs,
    });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-auto-stop") {
    const r = await callIdpSimulator(db, "auto/stop", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-action") {
    const body: Record<string, unknown> = {
      directoryId: directory.id,
      action: String(form.get("action") ?? ""),
    };
    for (const key of ["userName", "givenName", "familyName", "displayName"]) {
      const value = form.get(key);
      if (value != null) body[key] = String(value);
    }
    const r = await callIdpSimulator(db, "action", body);
    return r.ok ? {} : { error: r.error };
  }

  if (intent === "set-mode") {
    const mode = String(form.get("mode") ?? "");
    if (!MODES.includes(mode as Mode)) {
      return { error: `That mode is not one of ${MODES.join(", ")}.` };
    }
    return setPanelDirectoryMode(
      db,
      directory,
      mode as Mode,
      await panelEventLinkOptions(db, directory, context.get(demoModeContext)),
      form.get("switch_without_links") === "on",
    );
  }

  if (intent === "run-backfill") {
    if (directory.mode !== "dual-write" && directory.mode !== "workos-primary") {
      return {
        error:
          "Backfill runs in dual-write or workos-primary, the modes where the proxy is still " +
          "writing native, so live writes keep flowing while it replays.",
      };
    }
    const backfill = await runBackfill(
      db,
      directory as Directory,
      await panelEventLinkOptions(db, directory, context.get(demoModeContext)),
    );
    return { backfill };
  }

  if (intent === "clean-workos") {
    // Only SCIM DELETEs against the directory — never touches the directory's
    // WorkOS URL/token or the id mappings. The proxy self-heals a mapping whose
    // resource was deleted on the next mirror (see mirrorUpsert).
    const result = await cleanWorkosDirectory(directory.workos_url, directory.workos_token);
    if (!result.ok) {
      return { error: "The WorkOS endpoint didn't respond, so nothing was deleted." };
    }
    return {};
  }

  return { error: "That action is not recognized." };
}

// --- flow rail ------------------------------------------------------------

// --- cells ----------------------------------------------------------------

function PresenceCell({ state }: { state: Presence }) {
  if (state === "absent") {
    return (
      <Text color="gray" size="2" style={{ opacity: 0.5 }}>
        —
      </Text>
    );
  }
  return (
    <Badge color={state === "active" ? "green" : "gray"} variant="soft">
      {state === "active" ? "Active" : "Inactive"}
    </Badge>
  );
}

function CountCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Text color="gray" size="2" style={{ opacity: 0.5 }}>
        —
      </Text>
    );
  }
  return (
    <Text size="2">
      {value} {value === 1 ? "member" : "members"}
    </Text>
  );
}

/**
 * The members of a group worth naming: the ones the native app and WorkOS
 * disagree about, and the ones WorkOS retains for a deleted user.
 *
 * A count alone can only say a group differs; this says *which* member and which
 * side holds them, which is the difference between a number to stare at and a
 * row to act on. Members the two sides agree on are left out — every group would
 * otherwise print its whole roster. Rendered only when the WorkOS column is
 * readable, for the same reason the row highlight is: with no WorkOS side to
 * compare against, every native member would read as a difference.
 */
function MemberNotes({ members }: { members: GroupMemberReconRow[] }) {
  const notable = members.filter((m) => m.diverged || m.tombstone);
  if (notable.length === 0) return null;
  return (
    <Flex direction="column" gap="1">
      {notable.map((member) => (
        <Flex
          align="center"
          gap="2"
          key={member.name}
          wrap="wrap"
          // Same treatment as a deleted user's row: quiet, not hidden.
          style={member.tombstone ? { opacity: 0.6 } : undefined}
        >
          <Text color="gray" size="1">
            {member.name}
          </Text>
          {member.tombstone ? (
            <Badge color="white" lowContrast>
              deleted
            </Badge>
          ) : (
            <Badge color="yellow" variant="soft">
              {member.workos ? "WorkOS only" : "native only"}
            </Badge>
          )}
        </Flex>
      ))}
    </Flex>
  );
}

const MODE_LABEL: Record<Mode, string> = {
  passthrough: "Passthrough",
  "dual-write": "Dual-write",
  "workos-primary": "WorkOS-primary",
  "workos-only": "WorkOS-only",
};
const MODE_COLOR: Record<Mode, "gray" | "blue" | "green" | "amber"> = {
  passthrough: "gray",
  "dual-write": "blue",
  // Amber, between dual-write's blue and the green of a finished cutover: WorkOS
  // is authoritative but the migration is not over.
  "workos-primary": "amber",
  "workos-only": "green",
};

export default function PanelLive() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as
    | { error?: string; eventLinks?: GroupEventLinkSummary; backfill?: BackfillSummary }
    | undefined;
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [live, revalidator]);

  if (!data.directory) {
    return (
      <EmptyState.Root
        title="No directory yet"
        subtitle="Create a directory on the Directories tab, then this console tracks all three directories live."
      />
    );
  }

  const { directory, users, groups, workosReachable, workosCount, workosConfigured, auto, events } =
    data;
  const mode = directory.mode as Mode;
  // Gate the native-side tombstone exclusion on WorkOS having actually
  // responded: an unreachable WorkOS returns an empty listing, and reading that
  // as genuine absence would reclassify every native-inactive/idp-absent user as
  // a deleted tombstone during the outage, hiding real drift.
  const workosComplete = workosReachable && workosCount.count !== null && !workosCount.truncated;
  const userRows = reconcileUsers(users, { workosReachable: workosComplete });
  const groupRows = reconcileGroups(groups, users, { workosReachable: workosComplete });
  const userDiffs = userRows.filter((r) => r.diverged).length;
  const groupDiffs = groupRows.filter((r) => r.diverged).length;
  // Split tombstones by orientation so the headline describes each accurately:
  // WorkOS keeps the inactive record after native dropped it, vs the native app
  // keeps it (deactivate-in-place) after WorkOS and the IdP dropped it.
  const tombs = tombstoneSummary(userRows, groupRows);
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const userTombClauses = [
    tombs.users.workos > 0 &&
      `${tombs.users.workos} deleted ${plural(tombs.users.workos, "user", "users")} WorkOS keeps as inactive SCIM ${plural(tombs.users.workos, "record", "records")}`,
    tombs.users.native > 0 &&
      `${tombs.users.native} ${plural(tombs.users.native, "user", "users")} the native app keeps as inactive after WorkOS and the IdP dropped ${plural(tombs.users.native, "it", "them")}`,
  ].filter(Boolean);
  const memberTombClauses = [
    tombs.members.workos > 0 &&
      `${tombs.members.workos} group ${plural(tombs.members.workos, "membership", "memberships")} WorkOS still holds`,
    tombs.members.native > 0 &&
      `${tombs.members.native} group ${plural(tombs.members.native, "membership", "memberships")} the native app still holds`,
  ].filter(Boolean);
  const excludedText = [...userTombClauses, ...memberTombClauses].join(", and ");
  const converged = userDiffs === 0 && groupDiffs === 0;
  const showDiff = workosConfigured && workosComplete;
  const settingMode = navigation.formData?.get("intent") === "set-mode";
  const backfilling = navigation.formData?.get("intent") === "run-backfill";

  const activeCount = (rows: DirRow[]) => rows.filter((r) => r.active === 1).length;
  const counts = {
    idp: activeCount(users.idp),
    native: activeCount(users.native),
    workos: workosCount.count,
    workosTruncated: workosCount.truncated,
  };

  return (
    <Flex direction="column" gap="4">
      <Flex align="start" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            Live state
          </Heading>
          <Text color="gray" size="2">
            The native app, WorkOS, and the IdP directory side by side — watch them converge as the
            proxy routes SCIM writes.
          </Text>
        </Flex>
        <Flex align="center" gap="3">
          <Badge color={live ? "green" : "gray"} variant="soft">
            {live ? "Live" : "Paused"}
          </Badge>
          <Button variant="soft" onClick={() => setLive((v) => !v)}>
            {live ? "Pause" : "Resume"}
          </Button>
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </Button>
        </Flex>
      </Flex>

      {actionData?.error && (
        <Callout.Root color="red">
          <Callout.Text>{actionData.error}</Callout.Text>
        </Callout.Root>
      )}

      {actionData?.eventLinks && <EventLinkResult summary={actionData.eventLinks} />}
      {actionData?.backfill && (
        <Flex direction="column" gap="2">
          <Text size="2">
            Backfill: {actionData.backfill.users.mirrored} users and{" "}
            {actionData.backfill.groups.mirrored} groups mirrored;{" "}
            {actionData.backfill.users.failed + actionData.backfill.groups.failed} failed.
          </Text>
          {actionData.backfill.errors.map((error, index) => (
            <Text key={index} color="red" size="2">
              {error}
            </Text>
          ))}
          {actionData.backfill.eventLinks && (
            <EventLinkResult summary={actionData.backfill.eventLinks} />
          )}
        </Flex>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <FlowRail mode={mode} counts={counts} />
          <Flex align="center" gap="3" wrap="wrap">
            <Text size="2" weight="medium">
              Proxy mode
            </Text>
            {MODES.map((m) => (
              <Form key={m} method="post">
                <input name="directoryId" type="hidden" value={directory.id} />
                <input name="intent" type="hidden" value="set-mode" />
                <input name="mode" type="hidden" value={m} />
                {m === "workos-only" && mode !== "workos-only" && <SwitchWithoutLinks />}
                <Button
                  color={MODE_COLOR[m]}
                  disabled={m === mode || settingMode}
                  type="submit"
                  variant={m === mode ? "solid" : "soft"}
                >
                  {MODE_LABEL[m]}
                </Button>
              </Form>
            ))}
            <Box className="grow" />
            <Form method="post">
              <input name="directoryId" type="hidden" value={directory.id} />
              <input name="intent" type="hidden" value="run-backfill" />
              <Button
                disabled={(mode !== "dual-write" && mode !== "workos-primary") || backfilling}
                loading={backfilling}
                type="submit"
                variant="soft"
              >
                Run backfill
              </Button>
            </Form>
            <CleanWorkosButton
              directoryId={directory.id}
              disabled={!workosConfigured}
              isMock={data.workosIsMock}
            />
            <ResetNativeButton />
          </Flex>
        </Flex>
      </Card>

      <SimulatorControls auto={auto} directoryId={directory.id} />

      {!workosConfigured ? (
        <Callout.Root color="gray">
          <Callout.Text>
            No WorkOS endpoint is set on this directory, so only the native app and IdP are shown.
            Set one on the directory page — the mock at{" "}
            <Code>http://localhost:8788/mock-workos/scim/v2</Code> for a self-contained run, or a
            real WorkOS directory.
          </Callout.Text>
        </Callout.Root>
      ) : !workosReachable ? (
        <Callout.Root color="red">
          <Callout.Text>
            The WorkOS endpoint didn't respond, so its column is unavailable and convergence can't
            be computed. Check the endpoint URL and bearer token on the directory page.
          </Callout.Text>
        </Callout.Root>
      ) : !workosComplete ? (
        <Callout.Root color="gray">
          <Callout.Text>
            The WorkOS user listing is incomplete or unavailable. Its active-user count is a lower
            bound when shown, and convergence cannot be determined from these records.
          </Callout.Text>
        </Callout.Root>
      ) : converged ? (
        <Callout.Root color="green">
          <Callout.Text>
            Native app and WorkOS agree on the loaded records — {counts.native} active{" "}
            {counts.native === 1 ? "user" : "users"}, {groups.native.length}{" "}
            {groups.native.length === 1 ? "group" : "groups"}. Inactive users are excluded from the
            user count and remain listed below.
            {excludedText ? ` Excluded from divergence: ${excludedText}.` : ""}
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Callout.Root color="yellow">
          <Callout.Text>
            Native app and WorkOS differ on {userDiffs} {userDiffs === 1 ? "user" : "users"} and{" "}
            {groupDiffs} {groupDiffs === 1 ? "group" : "groups"}
            {excludedText ? `, excluding ${excludedText}` : ""}. That is expected mid-migration —
            dual-write plus a backfill converges them, and workos-primary keeps them converged
            because the proxy writes both sides; workos-only diverges them until the listener
            catches native up.
          </Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              Users
            </Heading>
            <Text color="gray" size="2">
              One row per email across all three directories. Highlighted rows differ between the
              native app and WorkOS. A <Code>deleted</Code> row is one WorkOS retains as an inactive
              SCIM record after the native app dropped its row — a difference in what a delete
              leaves behind, not divergence, so it is shown but not counted.
            </Text>
          </Flex>
          {userRows.length === 0 ? (
            <EmptyState.Root
              title="No users anywhere yet"
              subtitle="Seed or add a user on the IdP simulator tab to see it land here."
            />
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>User</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Native app</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>WorkOS</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>IdP</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {userRows.map((row) => (
                  <Table.Row
                    key={row.name}
                    style={
                      showDiff && row.diverged
                        ? { background: "var(--yellow-2)" }
                        : // Quiet, not hidden: the record is still the answer to
                          // "where did that user go", so it stays inspectable and
                          // recedes rather than disappearing.
                          row.tombstone
                          ? { opacity: 0.6 }
                          : undefined
                    }
                  >
                    <Table.Cell>
                      <Flex align="center" gap="2" wrap="wrap">
                        <Text size="2">{row.name}</Text>
                        {row.tombstone ? (
                          <Badge color="white" lowContrast>
                            deleted
                          </Badge>
                        ) : null}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <PresenceCell state={row.native} />
                    </Table.Cell>
                    <Table.Cell>
                      <PresenceCell state={row.workos} />
                    </Table.Cell>
                    <Table.Cell>
                      <PresenceCell state={row.idp} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              Groups
            </Heading>
            <Text color="gray" size="2">
              Member count per directory, as each one reports it. Highlighted rows differ between
              the native app and WorkOS — by identity, so the row names the member that differs and
              which side holds it. A <Code>deleted</Code> member is one WorkOS keeps in the group
              after the native app dropped both the user and the edge; like the deleted users above
              it is shown but not counted.
            </Text>
          </Flex>
          {groupRows.length === 0 ? (
            <EmptyState.Root
              title="No groups anywhere yet"
              subtitle="Create a group on the IdP simulator tab to see it land here."
            />
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Group</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Native app</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>WorkOS</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>IdP</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {groupRows.map((row) => (
                  <Table.Row
                    key={row.name}
                    style={showDiff && row.diverged ? { background: "var(--yellow-2)" } : undefined}
                  >
                    <Table.Cell>
                      <Flex direction="column" gap="1">
                        <Text size="2">{row.name}</Text>
                        {showDiff ? <MemberNotes members={row.members} /> : null}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <CountCell value={row.native} />
                    </Table.Cell>
                    <Table.Cell>
                      <CountCell value={row.workos} />
                    </Table.Cell>
                    <Table.Cell>
                      <CountCell value={row.idp} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              DSync events
            </Heading>
            <Text color="gray" size="2">
              The last 25 DSync events the native app's listener received after cutover — applied (a
              state transition), skipped (a no-op or superseded by a newer event), or ignored.
            </Text>
          </Flex>
          {events.length === 0 ? (
            <EmptyState.Root
              title="No events yet"
              subtitle="Events appear in workos-only mode, once WorkOS delivers DSync webhooks to the native listener."
            />
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Event</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>IdP id</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Action</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Detail</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {events.map((event: ListenerEvent) => (
                  <Table.Row key={event.id}>
                    <Table.Cell>
                      <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                        {event.ts}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Code size="1">{event.event_type}</Code>
                    </Table.Cell>
                    <Table.Cell>
                      {event.idp_id ? (
                        <Code size="1">{event.idp_id}</Code>
                      ) : (
                        <Text color="gray" size="1">
                          —
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge color={ACTION_BADGE_COLORS[event.action]}>{event.action}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Box maxWidth="320px">
                        <Text color="gray" size="1">
                          {event.detail ?? ""}
                        </Text>
                      </Box>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Flex>
      </Card>
    </Flex>
  );
}

function SimulatorControls({
  auto,
  directoryId,
}: {
  auto: AutoStateRow | null;
  directoryId: string;
}) {
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const pendingAction = navigation.formData?.get("action");
  const running = auto?.running === 1;

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <Heading as="h3" size="3">
            IdP simulator
          </Heading>
          <Text color="gray" size="2">
            Drive the source directory from here. Every action sends a real SCIM request through the
            proxy, exactly like Okta would.
          </Text>
        </Flex>

        <Flex align="center" gap="3" wrap="wrap">
          <Form method="post">
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-seed" />
            <Button loading={pendingIntent === "idp-seed"} type="submit">
              Seed directory
            </Button>
          </Form>
          <SimulatorUserDialog
            directoryId={directoryId}
            pending={pendingAction === "create-user"}
          />
          <SimulatorGroupDialog
            directoryId={directoryId}
            pending={pendingAction === "create-group"}
          />
          <Box className="grow" />
          <ResetSimulatorButton directoryId={directoryId} />
        </Flex>

        <Flex
          align="center"
          gap="3"
          justify="between"
          wrap="wrap"
          className="rounded-[var(--radius-3)] border border-[var(--gray-a5)] bg-[var(--gray-a2)] px-4 py-3"
        >
          <Flex align="center" gap="3">
            <Text size="2" weight="medium">
              Auto-run
            </Text>
            <Badge color={running ? "green" : "gray"} variant="soft">
              {running ? "Running" : "Idle"}
            </Badge>
            {running && (
              <Text color="gray" size="2">
                {auto?.tick_count ?? 0} ticks, one every{" "}
                {((auto?.interval_ms ?? DEFAULT_INTERVAL_MS) / 1000).toString()}s
              </Text>
            )}
          </Flex>
          {running ? (
            <Form method="post">
              <input name="directoryId" type="hidden" value={directoryId} />
              <input name="intent" type="hidden" value="idp-auto-stop" />
              <Button loading={pendingIntent === "idp-auto-stop"} type="submit" variant="soft">
                Stop auto-run
              </Button>
            </Form>
          ) : (
            <Form method="post">
              <input name="directoryId" type="hidden" value={directoryId} />
              <input name="intent" type="hidden" value="idp-auto-start" />
              <Flex align="center" gap="3">
                <Select.Root defaultValue={String(DEFAULT_INTERVAL_MS)} name="intervalMs">
                  <Select.Trigger aria-label="Auto-run interval" />
                  <Select.Content>
                    {INTERVAL_OPTIONS.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Button variant="solid" loading={pendingIntent === "idp-auto-start"} type="submit">
                  Start auto-run
                </Button>
              </Flex>
            </Form>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

function SimulatorUserDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button variant="soft">Add user</Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Add user"
              description="Provisions a new user in the simulated directory. The IdP immediately sends a SCIM create through the proxy."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-action" />
            <input name="action" type="hidden" value="create-user" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="live-user-name">Email</FieldLabel>
              <TextField.Root
                autoFocus
                id="live-user-name"
                name="userName"
                placeholder="ada@acme.test"
                required
                type="email"
              />
            </Flex>
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="live-given-name">First name</FieldLabel>
                <TextField.Root id="live-given-name" name="givenName" placeholder="Ada" />
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="live-family-name">Last name</FieldLabel>
                <TextField.Root id="live-family-name" name="familyName" placeholder="Lovelace" />
              </Flex>
            </Grid>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button variant="solid" loading={pending} type="submit">
                Add user
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SimulatorGroupDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button variant="soft">Create group</Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Create group"
              description="Creates a new group in the simulated directory and pushes it through the proxy."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-action" />
            <input name="action" type="hidden" value="create-group" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="live-group-name">Group name</FieldLabel>
              <TextField.Root
                autoFocus
                id="live-group-name"
                name="displayName"
                placeholder="Engineering"
                required
              />
            </Flex>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button variant="solid" loading={pending} type="submit">
                Create group
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ResetSimulatorButton({ directoryId }: { directoryId: string }) {
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "idp-reset";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" variant="soft">
          Reset simulator
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Reset the simulator?"
              description="Wipes the simulated IdP directory and its activity feed and stops auto-run. It does not touch what the proxy already provisioned into WorkOS or the native app."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-reset" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={resetting} type="submit">
                  Reset simulator
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function CleanWorkosButton({
  directoryId,
  disabled,
  isMock,
}: {
  directoryId: string;
  disabled: boolean;
  isMock: boolean;
}) {
  const navigation = useNavigation();
  const cleaning = navigation.formData?.get("intent") === "clean-workos";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" disabled={disabled} variant="soft">
          Clean WorkOS
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Clean the WorkOS directory?"
              description={
                isMock
                  ? "Sends a SCIM delete for every user and group in the mock WorkOS directory. The directory's endpoint stays configured; the native app and IdP are untouched."
                  : "Sends a SCIM delete for every user and group in the real WorkOS directory this directory points at — this removes real data from that directory. The directory's endpoint stays configured; the native app and IdP are untouched."
              }
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="clean-workos" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={cleaning} type="submit">
                  Clean WorkOS
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function ResetNativeButton() {
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "reset-native";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" variant="soft">
          Reset native app
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Reset the native app?"
              description="Deletes every user and group from the customer app's directory and its DSync listener log. The proxy directory, id mappings, and WorkOS are left untouched."
            />
            <input name="intent" type="hidden" value="reset-native" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={resetting} type="submit">
                  Reset native app
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

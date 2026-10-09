import { panelEventLinkOptions, setPanelDirectoryMode } from "./event-link-cutover";
import { EventLinkResult, SwitchWithoutLinks } from "./event-link-result";
import {
  preloadForOperation,
  type GroupEventLinkSummary,
} from "../../../workers/shared/event-link-preload";
import type { Route } from "./+types/directory-overview";
import { useEffect, useRef, useState } from "react";

import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { datastoreContext, demoModeContext } from "../../context";
import {
  ReconcileInFlightError,
  runBackfill,
  runReconcileFromWorkos,
} from "../../../workers/shared/backfill";
import {
  getConfig,
  getDirectoryById,
  listDirectories,
  listNativeWriteFailures,
  setDirectoryLogPersistence,
  rotateProxyToken,
  setDirectoryNative,
  setDirectoryWorkos,
  setDirectoryWorkosDirectoryId,
  withDatastoreRetry,
} from "../../../workers/shared/db";
import {
  DEMO_DIRECTORY_ID_KEY,
  clientTokenKey,
  demoDirectoryId,
  publishMintedToken,
} from "../../../workers/shared/client-tokens";
import { checkNativeNamespace } from "../../../workers/shared/native-namespace";
import { joinScimUrl } from "../../../workers/shared/scim";
import { countUsers, getUserCountStatus, type EndpointCount } from "./user-count";
import { validateUpstreamUrl } from "../../../workers/shared/upstream-url";
import type { BackfillSummary, Mode, NativeWriteFailure } from "../../../workers/shared/types";
import { MODES } from "../../../workers/shared/types";
import {
  Callout,
  Card,
  Checkbox,
  Code,
  Flex,
  Grid,
  RadioCards,
  Text,
  TextField,
} from "@radix-ui/themes";
import * as AlertDialog from "../../ui/alert-dialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { FlowRail } from "./flow-rail";
import { CardHeader, CopyButton, FieldLabel, trimTrailingSlash } from "./ui";

interface HealthResult {
  target: "native" | "workos";
  status: number | null;
  ok: boolean;
  detail?: string;
}

interface TopologyResult {
  native: EndpointCount;
  workos: EndpointCount;
}

interface OverviewActionData {
  error?: string;
  eventLinks?: GroupEventLinkSummary;
  backfill?: BackfillSummary;
  reconcile?: BackfillSummary;
  health?: HealthResult;
  topology?: TopologyResult;
  /** A freshly minted proxy token, in the clear. Present only in the response to a
   *  rotate, and never persisted anywhere readable — the row keeps a digest, so
   *  this render is the operator's only chance to copy it. */
  rotatedToken?: string;
}

const MODE_DETAILS: { value: Mode; description: string }[] = [
  {
    value: "passthrough",
    description:
      "Every read and write goes to native. WorkOS is untouched. The rollback landing spot.",
  },
  {
    value: "dual-write",
    description:
      "Write native first; only on a native 2xx, mirror the write into WorkOS via the migrated-id contract. Reads served from native.",
  },
  {
    value: "workos-primary",
    description:
      "WorkOS answers the IdP and the proxy still writes native directly, concurrently; the request fails if either side does. Native never goes stale, so rolling back is only a mode change. Dwell here.",
  },
  {
    value: "workos-only",
    description:
      "Cutover. WorkOS is the only SCIM target and the proxy goes silent toward native. The DSync listener becomes the app's feed.",
  },
];

export async function loader({ context, params }: Route.LoaderArgs) {
  const db = context.get(datastoreContext);
  const directory = await getDirectoryById(db, params.id ?? "");
  if (!directory) {
    throw new Response("Directory not found", { status: 404 });
  }
  const [proxyPublicUrl, nativePublicUrl] = await Promise.all([
    getConfig(db, "proxy.public_url"),
    getConfig(db, "native.public_url"),
  ]);
  return {
    directory,
    proxyPublicUrl: proxyPublicUrl ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
    nativeWriteFailures: await listNativeWriteFailures(db, directory.id),
    isDemoDirectory: context.get(demoModeContext) && directory.id === (await demoDirectoryId(db)),
  };
}

async function checkEndpoint(
  target: "native" | "workos",
  url: string,
  token: string,
): Promise<HealthResult> {
  if (!url) {
    return {
      target,
      status: null,
      ok: false,
      detail: "No endpoint URL is configured for this target yet.",
    };
  }
  try {
    const response = await fetch(`${joinScimUrl(url, "/Users")}?count=1`, {
      headers: { Authorization: `Bearer ${token}` },
      // Same reason as scimFetch: don't let a saved endpoint redirect this
      // bearer-token probe to a metadata address after host validation.
      redirect: "manual",
    });
    return { target, status: response.status, ok: response.ok };
  } catch (error) {
    return {
      target,
      status: null,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function action({
  context,
  params,
  request,
}: Route.ActionArgs): Promise<Response | OverviewActionData> {
  const db = context.get(datastoreContext);
  const directory = await getDirectoryById(db, params.id ?? "");
  if (!directory) {
    throw new Response("Directory not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = form.get("intent");

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

  if (intent === "rotate-proxy-token") {
    const token = await rotateProxyToken(db, directory.id);
    // The old token stopped working the moment that returned, so a bundled
    // simulator still holding it would start failing every request.
    await publishMintedToken(db, directory.id, token, {
      demoMode: context.get(demoModeContext),
    });
    // Returned rather than redirected: a redirect would drop the plaintext, and
    // this response is the only place it exists.
    return { rotatedToken: token };
  }

  if (intent === "set-log-persistence") {
    await setDirectoryLogPersistence(db, directory.id, form.get("on") === "true");
    return {};
  }

  if (intent === "save-native") {
    const nativeUrl = String(form.get("native_url") ?? "").trim();
    const nativeToken = String(form.get("native_token") ?? "").trim();
    const tokenPartitioned = form.get("native_token_partitioned") === "on";
    const urlError = validateUpstreamUrl(nativeUrl);
    if (urlError) {
      return { error: urlError };
    }
    // This intent can *move* a directory onto an endpoint another already uses,
    // which is the same hazard as creating it there. Every other
    // directory is a candidate; this one is excluded, or re-saving an unchanged
    // URL would collide with itself. The token and attestation being saved ride
    // along: this is the one place an operator can attest token partitioning,
    // and the same check refuses a token edit that would equal a neighbour's in
    // an attested group — the distinct token is the boundary being asserted.
    const others = (await listDirectories(db)).filter((other) => other.id !== directory.id);
    const namespaceError = checkNativeNamespace(nativeUrl, others, {
      native_token: nativeToken,
      native_token_partitioned: tokenPartitioned ? 1 : 0,
    });
    if (namespaceError) {
      return { error: namespaceError };
    }
    await setDirectoryNative(db, directory.id, nativeUrl, nativeToken, tokenPartitioned);
    return {};
  }

  if (intent === "save-workos") {
    const workosUrl = String(form.get("workos_url") ?? "").trim();
    const urlError = validateUpstreamUrl(workosUrl);
    if (urlError) {
      return { error: urlError };
    }
    await setDirectoryWorkos(
      db,
      directory.id,
      workosUrl,
      String(form.get("workos_token") ?? "").trim(),
    );
    return {};
  }

  if (intent === "save-workos-directory-id") {
    try {
      await setDirectoryWorkosDirectoryId(
        db,
        directory.id,
        String(form.get("workos_directory_id") ?? "").trim(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: /unique/i.test(message)
          ? "That WorkOS directory id is already assigned to another directory."
          : message,
      };
    }
    return {};
  }

  if (intent === "preload-event-links") {
    return {
      eventLinks: await preloadForOperation(
        db,
        directory,
        await panelEventLinkOptions(db, directory, context.get(demoModeContext)),
      ),
    };
  }

  if (intent === "run-backfill") {
    // Available on workos-primary too: the proxy is still writing native there, so
    // a snapshot replay into WorkOS is as safe as it is on dual-write — and an
    // operator who reaches rung 3 and finds WorkOS short a few resources should
    // not have to drop back a rung to fix it.
    if (directory.mode !== "dual-write" && directory.mode !== "workos-primary") {
      return {
        error:
          "Backfill runs in dual-write or workos-primary mode, so live writes keep flowing while the snapshot replays.",
      };
    }
    const backfill = await runBackfill(
      db,
      directory,
      await panelEventLinkOptions(db, directory, context.get(demoModeContext)),
    );
    return { backfill };
  }

  if (intent === "reconcile-from-workos") {
    // On workos-only this repairs a lagging DSync listener before a rollback. On
    // workos-primary it is the repair for a native write that failed while WorkOS
    // kept the change: the resources below name exactly what it has to fix.
    if (directory.mode !== "workos-only" && directory.mode !== "workos-primary") {
      return {
        error:
          "Reconcile from WorkOS runs in workos-primary or workos-only mode, to bring the native app fully current.",
      };
    }
    try {
      const reconcile = await runReconcileFromWorkos(
        db,
        directory,
        await panelEventLinkOptions(db, directory, context.get(demoModeContext)),
      );
      return { reconcile };
    } catch (error) {
      if (!(error instanceof ReconcileInFlightError)) throw error;
      return { error: error.message };
    }
  }

  if (intent === "test-native") {
    return {
      health: await checkEndpoint("native", directory.native_url, directory.native_token),
    };
  }

  if (intent === "test-workos") {
    return {
      health: await checkEndpoint("workos", directory.workos_url, directory.workos_token),
    };
  }

  if (intent === "topology") {
    const [native, workos] = await Promise.all([
      countUsers(directory.native_url, directory.native_token),
      countUsers(directory.workos_url, directory.workos_token),
    ]);
    return { topology: { native, workos } };
  }

  if (intent === "delete-directory") {
    // The bundled simulators can only drive the directory named by
    // idp.demo_directory_id, and nothing re-publishes their plaintext token
    // after a delete — so deleting it wedges demo mode: every simulator action
    // afterwards no-ops with nothing to drive. Refuse rather than wedge.
    if (context.get(demoModeContext) && directory.id === (await demoDirectoryId(db))) {
      return {
        error:
          "This is the bundled demo directory — the built-in IdP and native-app simulators drive it, and deleting it leaves demo mode with nothing to drive. Start the bridge without DEMO_MODE to remove it.",
      };
    }
    await withDatastoreRetry(() =>
      db.batch([
        db.prepare("DELETE FROM id_mappings WHERE directory_id = ?").bind(directory.id),
        db.prepare("DELETE FROM proxy_log WHERE directory_id = ?").bind(directory.id),
        db.prepare("DELETE FROM native_write_failures WHERE directory_id = ?").bind(directory.id),
        // The simulator's plaintext token copy, and the demo-directory pointer if
        // it names this row. Left behind, the pointer wedges the next demo-mode
        // boot: adoption bails on a set key, so the simulators resolve a
        // directory that no longer exists and every action silently no-ops.
        db.prepare("DELETE FROM poc_config WHERE key = ?").bind(clientTokenKey(directory.id)),
        db
          .prepare("DELETE FROM poc_config WHERE key = ? AND value = ?")
          .bind(DEMO_DIRECTORY_ID_KEY, directory.id),
        db.prepare("DELETE FROM scim_directories WHERE id = ?").bind(directory.id),
      ]),
    );
    return redirect("/panel");
  }

  return { error: "That form action is not recognized." };
}

function LogPersistenceCard({ on, pending }: { on: boolean; pending: boolean }) {
  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <CardHeader
          title="Log persistence"
          description="Persist this directory's proxy requests to the activity log and id mappings. Enable it only for directories you're actively monitoring — a large fleet logging every request adds up. When off, requests still proxy and mirror exactly the same."
        />
        <Flex align="center" gap="3" wrap="wrap">
          <Badge color={on ? "green" : "gray"} variant={on ? undefined : "soft"}>
            {on ? "Monitored" : "Not persisted"}
          </Badge>
          <Form method="post">
            <input type="hidden" name="intent" value="set-log-persistence" />
            <input type="hidden" name="on" value={on ? "false" : "true"} />
            <Button loading={pending} type="submit" variant="soft">
              {on ? "Disable logging" : "Enable logging"}
            </Button>
          </Form>
        </Flex>
      </Flex>
    </Card>
  );
}

function ModeCard({ currentMode, pending }: { currentMode: Mode; pending: boolean }) {
  const submit = useSubmit();
  const [selected, setSelected] = useState<Mode>(currentMode);
  const [override, setOverride] = useState(false);
  const dirty = selected !== currentMode;
  // The two transitions worth a confirmation are the two that change who writes
  // the native app: entering workos-only (the proxy goes silent toward native and
  // its DSync listener takes over) and leaving it. Every other step on the ladder,
  // including workos-primary in either direction, keeps native under direct proxy
  // writes — that is the whole point of the rung, so it does not get a scary modal.
  const isCutover = dirty && selected === "workos-only";
  const isRollback = dirty && currentMode === "workos-only";
  const cutoverDescription =
    currentMode === "workos-primary"
      ? "WorkOS is already answering the IdP, so authority does not move. What changes is who writes the native app: the proxy stops, and the customer's DSync event listener becomes the only feed. Confirm the listener is running and applying events — apply_dsync_events flips to true the moment this lands."
      : "The proxy will stop sending SCIM traffic to the native endpoint entirely — WorkOS becomes the only target. Enable the customer's DSync event listener first, or the native directory will go stale. Consider workos-primary first: it moves authority to WorkOS while the proxy keeps writing native, so this step is only about the listener.";
  const applyMode = () =>
    submit(
      { intent: "set-mode", mode: selected, switch_without_links: override ? "on" : "" },
      { method: "post" },
    );

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <CardHeader
          title="Mode"
          description="The IdP never changes. The proxy's mode decides where each request goes and which side is the source of truth."
        />
        <RadioCards.Root
          columns={{ initial: "1", sm: "2", md: "4" }}
          value={selected}
          onValueChange={(value) => setSelected(value as Mode)}
        >
          {MODE_DETAILS.map((mode) => (
            <RadioCards.Item key={mode.value} value={mode.value}>
              <Flex direction="column" gap="1" width="100%">
                <Text size="2" weight="medium">
                  {mode.value}
                </Text>
                <Text color="gray" size="1">
                  {mode.description}
                </Text>
              </Flex>
            </RadioCards.Item>
          ))}
        </RadioCards.Root>
        <Flex justify="end">
          {isCutover || isRollback ? (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button variant="solid" disabled={pending}>
                  {isCutover ? "Cut over to WorkOS" : `Roll back to ${selected}`}
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content size="2">
                <Flex direction="column" gap="5">
                  <AlertDialog.Header
                    title={isCutover ? "Cut over to WorkOS?" : "Roll back from workos-only?"}
                    description={
                      isCutover
                        ? cutoverDescription
                        : selected === "workos-primary"
                          ? "The proxy resumes writing the native app directly and the listener goes inert, so native stops depending on webhook delivery. WorkOS keeps answering the IdP, so authority does not move. Let in-flight DSync events drain first so the listener finishes applying everything WorkOS already accepted."
                          : `The proxy will switch back to ${selected} and the untouched native SCIM handler resumes. Let in-flight DSync events drain first so the listener finishes applying everything WorkOS already accepted.`
                    }
                  />
                  {isCutover && (
                    <SwitchWithoutLinks checked={override} onCheckedChange={setOverride} />
                  )}
                  <AlertDialog.Footer>
                    <AlertDialog.Cancel>
                      <Button>Cancel</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button color="red" onClick={applyMode}>
                        {isCutover ? "Cut over" : "Roll back"}
                      </Button>
                    </AlertDialog.Action>
                  </AlertDialog.Footer>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          ) : (
            <Button variant="solid" disabled={!dirty} loading={pending} onClick={applyMode}>
              {dirty ? `Switch to ${selected}` : "Mode is up to date"}
            </Button>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

/**
 * The resources WorkOS holds a write for that native does not.
 *
 * The mode's claim is that native is current, so a divergence has to be visible
 * rather than inferred from a log a directory has to opt into. Repair is the
 * operator's call, not a background retry: a native app rejecting writes is
 * usually broken or misconfigured, and a queue draining into it unattended turns
 * one bad deploy into a silent replay hours later. Nothing here retries by itself
 * — rows also clear on their own when a later write to the same resource lands.
 */
function DivergenceCard({
  failures,
  mode,
  pending,
  reconcile,
}: {
  failures: NativeWriteFailure[];
  mode: Mode;
  pending: boolean;
  reconcile?: BackfillSummary;
}) {
  if (failures.length === 0 && mode !== "workos-primary") return null;

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3" justify="between">
          <CardHeader
            title="Native writes WorkOS kept and native refused"
            description="Resources WorkOS has a write for that the native app rejected or never received. The IdP was told the request failed, so it will usually retry and the row clears itself. Reconcile from WorkOS repairs the rest."
          />
          <Badge color={failures.length > 0 ? "red" : "green"}>
            {failures.length > 0 ? `${failures.length} diverged` : "none"}
          </Badge>
        </Flex>
        {failures.length > 0 && (
          <Flex direction="column" gap="2">
            {failures.map((failure) => (
              <Flex
                key={`${failure.resource_type}:${failure.resource_key}`}
                align="center"
                gap="2"
                wrap="wrap"
              >
                <Badge color="white" lowContrast>
                  {failure.resource_type}
                </Badge>
                <Code size="2" className="break-all">
                  {failure.resource_key}
                </Code>
                <Badge color="red">
                  {failure.method} {failure.native_status ?? "unreachable"}
                </Badge>
                {failure.attempts > 1 && <Badge color="gray">{failure.attempts} attempts</Badge>}
                <Text color="gray" size="1">
                  {failure.detail} — last seen {failure.last_seen_at}
                </Text>
              </Flex>
            ))}
            {mode === "workos-primary" || mode === "workos-only" ? (
              <Form method="post">
                <input type="hidden" name="intent" value="reconcile-from-workos" />
                <Flex justify="end">
                  <Button color="red" loading={pending} type="submit" variant="solid">
                    Reconcile from WorkOS
                  </Button>
                </Flex>
              </Form>
            ) : (
              // Rows can outlive a rollback, and offering the repair in a mode the
              // action refuses is worse than saying where it lives: reconciling into
              // native from a WorkOS that is not authoritative would push state the
              // IdP never sent to the system currently answering it.
              <Text color="gray" size="1">
                Reconcile from WorkOS is the repair, and it runs on workos-primary or workos-only —
                on {mode} the native app is authoritative, so a write to any of these resources
                clears its row on its own.
              </Text>
            )}
            {reconcile && <BackfillResult summary={reconcile} />}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

function EndpointCard({
  title,
  description,
  intent,
  urlField,
  tokenField,
  urlValue,
  tokenValue,
  buttonLabel,
  pending,
  children,
}: {
  title: string;
  description: string;
  intent: string;
  urlField: string;
  tokenField: string;
  urlValue: string;
  tokenValue: string;
  buttonLabel: string;
  pending: boolean;
  /** Extra fields submitted with this endpoint's form, rendered between the
   *  URL/token pair and the save button (the native card's token-partitioning
   *  attestation). */
  children?: React.ReactNode;
}) {
  return (
    <Card size="3">
      <Form method="post">
        <input type="hidden" name="intent" value={intent} />
        <Flex direction="column" gap="4">
          <CardHeader title={title} description={description} />
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor={urlField}>Base URL</FieldLabel>
              <TextField.Root
                defaultValue={urlValue}
                id={urlField}
                name={urlField}
                placeholder="https://…/scim/v2"
              />
            </Flex>
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor={tokenField}>Bearer token</FieldLabel>
              <TextField.Root
                defaultValue={tokenValue}
                id={tokenField}
                name={tokenField}
                // Keep password managers out of a field that holds a bearer token: the
                // vendored TextField spelled this `suppressPasswordManagers`.
                data-1p-ignore="true"
                data-lpignore="true"
                data-protonpass-ignore="true"
                data-bwignore="true"
              />
            </Flex>
          </Grid>
          {children}
          <Flex justify="end">
            <Button loading={pending} type="submit">
              {buttonLabel}
            </Button>
          </Flex>
        </Flex>
      </Form>
    </Card>
  );
}

function BackfillResult({ summary }: { summary: BackfillSummary }) {
  return (
    <Flex direction="column" gap="3">
      {summary.eventLinks && <EventLinkResult summary={summary.eventLinks} />}
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        {(["users", "groups"] as const).map((kind) => (
          <Flex key={kind} align="center" gap="2">
            <Text size="2" weight="medium">
              {kind === "users" ? "Users" : "Groups"}
            </Text>
            <Badge color="white" lowContrast>
              {summary[kind].total} total
            </Badge>
            <Badge color="green">{summary[kind].mirrored} mirrored</Badge>
            <Badge color={summary[kind].failed > 0 ? "red" : "gray"}>
              {summary[kind].failed} failed
            </Badge>
          </Flex>
        ))}
      </Grid>
      {summary.errors.length > 0 && (
        <Callout.Root color="red">
          <Callout.Text>
            {summary.errors.slice(0, 5).map((error, index) => (
              <Text as="div" key={index} size="2">
                {error}
              </Text>
            ))}
          </Callout.Text>
        </Callout.Root>
      )}
    </Flex>
  );
}

function LiveStateCard({ mode }: { mode: Mode }) {
  const fetcher = useFetcher<OverviewActionData>();
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      fetcher.submit({ intent: "topology" }, { method: "post" });
    }
  }, [fetcher]);

  const topo = fetcher.data?.topology;
  const counts = {
    native: topo?.native.count ?? null,
    nativeTruncated: topo?.native.truncated,
    workos: topo?.workos.count ?? null,
    workosTruncated: topo?.workos.truncated,
  };

  const sync = topo ? getUserCountStatus(topo.native, topo.workos) : null;

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3" justify="between">
          <CardHeader
            title="Live state"
            description="The native app and WorkOS for this directory, read live over SCIM. Counts are active users."
          />
          <Flex align="center" gap="2">
            {sync && <Badge color={sync.color}>{sync.label}</Badge>}
            <Button
              loading={fetcher.state !== "idle"}
              onClick={() => fetcher.submit({ intent: "topology" }, { method: "post" })}
              variant="soft"
            >
              Refresh
            </Button>
          </Flex>
        </Flex>
        <FlowRail counts={counts} mode={mode} />
      </Flex>
    </Card>
  );
}

export default function DirectoryOverview() {
  const { directory, proxyPublicUrl, nativePublicUrl, nativeWriteFailures, isDemoDirectory } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as OverviewActionData | undefined;
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const scimBaseUrl = `${trimTrailingSlash(proxyPublicUrl)}/scim/v2`;
  const statusUrl = `${trimTrailingSlash(proxyPublicUrl)}/status/directories/${directory.workos_directory_id || directory.id}`;
  const mockWorkosUrl = `${trimTrailingSlash(nativePublicUrl)}/mock-workos/scim/v2`;
  const health = actionData?.health;

  return (
    <Flex direction="column" gap="4">
      {actionData?.error && (
        <Callout.Root color="red">
          <Callout.Text>{actionData.error}</Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Identity provider"
            description="Paste these into the IdP's SCIM provisioning settings (Okta: header auth, HTTP Header — Bearer). Paste the token on its own: the proxy takes it with or without a Bearer prefix, so IdPs that send the Authorization header verbatim work too."
          />
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                SCIM base URL
              </Text>
              <Flex align="center" gap="2">
                <Code size="2" className="break-all">
                  {scimBaseUrl}
                </Code>
                <CopyButton value={scimBaseUrl} />
              </Flex>
            </Flex>
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                Bearer token
              </Text>
              {actionData?.rotatedToken ? (
                <Flex align="center" gap="2">
                  <Code size="2" className="break-all">
                    {actionData.rotatedToken}
                  </Code>
                  <CopyButton value={actionData.rotatedToken} />
                </Flex>
              ) : (
                <Flex align="center" gap="2">
                  <Code size="2">
                    {directory.proxy_token_hint
                      ? `…${directory.proxy_token_hint}`
                      : "not recoverable"}
                  </Code>
                  <Form method="post">
                    <input type="hidden" name="intent" value="rotate-proxy-token" />
                    <Button
                      loading={pendingIntent === "rotate-proxy-token"}
                      type="submit"
                      variant="soft"
                    >
                      Rotate
                    </Button>
                  </Form>
                </Flex>
              )}
              <Text color="gray" size="1">
                {actionData?.rotatedToken
                  ? "Copy it now — this is the only time it is shown. The previous token has already stopped working."
                  : "Stored as a hash, so it can't be shown again. Rotating mints a new one and immediately invalidates this one."}
              </Text>
            </Flex>
          </Grid>
        </Flex>
      </Card>

      <ModeCard
        key={directory.mode}
        currentMode={directory.mode}
        pending={pendingIntent === "set-mode"}
      />

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Group event links"
            description="Preload verified Directory Sync group identities before cutover, while groups are still live. Backfill and reconcile also run this step automatically."
          />
          <Form method="post">
            <input type="hidden" name="intent" value="preload-event-links" />
            <Button type="submit" loading={pendingIntent === "preload-event-links"}>
              Preload event links
            </Button>
          </Form>
          {actionData?.eventLinks && <EventLinkResult summary={actionData.eventLinks} />}
        </Flex>
      </Card>

      <LogPersistenceCard
        on={Boolean(directory.log_persistence)}
        pending={pendingIntent === "set-log-persistence"}
      />

      <LiveStateCard mode={directory.mode} />

      <DivergenceCard
        failures={nativeWriteFailures}
        mode={directory.mode}
        pending={pendingIntent === "reconcile-from-workos"}
        reconcile={actionData?.reconcile}
      />

      <EndpointCard
        title="Native SCIM endpoint"
        description="The customer's own SCIM server — authoritative until cutover. The proxy presents this bearer token."
        intent="save-native"
        urlField="native_url"
        tokenField="native_token"
        urlValue={directory.native_url}
        tokenValue={directory.native_token}
        buttonLabel="Save native endpoint"
        pending={pendingIntent === "save-native"}
      >
        <Flex direction="column" gap="2">
          <Text as="label" size="2">
            <Flex gap="2">
              <Checkbox
                defaultChecked={Boolean(directory.native_token_partitioned)}
                name="native_token_partitioned"
              />
              This SCIM service isolates rows by bearer token (token-partitioned)
            </Flex>
          </Text>
          <Text color="gray" size="1">
            Only if your SCIM service serves every tenant from this one URL and decides the tenant
            from the bearer token alone. Mark every directory that shares the URL and give each its
            own native token — the bridge then treats endpoint-plus-token as the namespace. This is
            your attestation: the bridge cannot verify the isolation, and if the service does not
            actually partition by token, a write meant for one directory can land on another's
            users. Prefer a path per tenant where you can.
          </Text>
        </Flex>
      </EndpointCard>

      <EndpointCard
        title="WorkOS directory endpoint"
        description={`For a local run, paste the mock endpoint (${mockWorkosUrl}) with the mock bearer token from Global settings. For the real thing, paste the endpoint and bearer token from a WorkOS dashboard generic SCIM directory.`}
        intent="save-workos"
        urlField="workos_url"
        tokenField="workos_token"
        urlValue={directory.workos_url}
        tokenValue={directory.workos_token}
        buttonLabel="Save WorkOS endpoint"
        pending={pendingIntent === "save-workos"}
      />

      <Card size="3">
        <Form method="post">
          <input type="hidden" name="intent" value="save-workos-directory-id" />
          <Flex direction="column" gap="4">
            <CardHeader
              title="Listener status endpoint"
              description="The customer's native app polls this from its DSync event listener and reads apply_dsync_events: apply the event when true, acknowledge and drop it when false. That field is the whole contract — native_authoritative only reports who owns the data. Authenticate with the directory's proxy bearer token above. Set the WorkOS directory id (directory_...) so the listener can address it by the id DSync events carry."
            />
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <Text color="gray" size="2" weight="medium">
                  Status URL
                </Text>
                <Flex align="center" gap="2">
                  <Code size="2" className="break-all">
                    {statusUrl}
                  </Code>
                  <CopyButton value={statusUrl} />
                </Flex>
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="workos-directory-id">WorkOS directory id</FieldLabel>
                <TextField.Root
                  defaultValue={directory.workos_directory_id ?? ""}
                  id="workos-directory-id"
                  name="workos_directory_id"
                  placeholder="directory_01…"
                />
              </Flex>
            </Grid>
            <Flex justify="end">
              <Button loading={pendingIntent === "save-workos-directory-id"} type="submit">
                Save WorkOS directory id
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Backfill"
            description="Snapshot the native directory and replay every user and group into WorkOS as migrated-id upserts."
          />
          {directory.mode !== "dual-write" && directory.mode !== "workos-primary" ? (
            <Flex align="center" gap="3" justify="between">
              <Text color="gray" size="2">
                Backfill is available in dual-write and workos-primary mode, so live writes keep
                flowing while the snapshot replays. Switch modes above to enable it.
              </Text>
              <Button disabled>Run backfill</Button>
            </Flex>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="run-backfill" />
              <Flex justify="end">
                <Button variant="solid" loading={pendingIntent === "run-backfill"} type="submit">
                  Run backfill
                </Button>
              </Flex>
            </Form>
          )}
          {actionData?.backfill && <BackfillResult summary={actionData.backfill} />}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Backfill from WorkOS → native (rollback)"
            description="The reverse of the forward backfill: snapshot the live WorkOS directory and replay every user and group back into the native app as migrated-id upserts. Run it before rolling back, to bring the native app fully current in case its DSync listener lagged."
          />
          {directory.mode !== "workos-only" && directory.mode !== "workos-primary" ? (
            <Flex align="center" gap="3" justify="between">
              <Text color="gray" size="2">
                Available in workos-primary and workos-only mode — that's when WorkOS is
                authoritative and the native app may be behind. Run it here to make native current,
                then roll back safely. Switch modes above to enable it.
              </Text>
              <Button disabled>Backfill from WorkOS</Button>
            </Flex>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="reconcile-from-workos" />
              <Flex justify="end">
                <Button
                  variant="solid"
                  loading={pendingIntent === "reconcile-from-workos"}
                  type="submit"
                >
                  Backfill from WorkOS
                </Button>
              </Flex>
            </Form>
          )}
          {actionData?.reconcile && <BackfillResult summary={actionData.reconcile} />}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Health"
            description="Sends GET /Users?count=1 to each endpoint with its stored bearer token."
          />
          <Flex gap="3">
            <Form method="post">
              <input type="hidden" name="intent" value="test-native" />
              <Button loading={pendingIntent === "test-native"} type="submit">
                Test native
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="test-workos" />
              <Button loading={pendingIntent === "test-workos"} type="submit">
                Test WorkOS
              </Button>
            </Form>
          </Flex>
          {health && (
            <Flex align="center" gap="2">
              <Badge color={health.ok ? "green" : "red"}>{health.ok ? "ok" : "failed"}</Badge>
              <Text size="2">
                The {health.target === "native" ? "native" : "WorkOS"} endpoint{" "}
                {health.status != null ? `returned ${health.status}` : "was unreachable"}
                {health.detail ? ` — ${health.detail}` : "."}
              </Text>
            </Flex>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex align="center" gap="4" justify="between">
          <Flex direction="column" gap="1">
            <Text size="3" weight="medium">
              Danger zone
            </Text>
            <Text color="gray" size="2">
              {isDemoDirectory
                ? "This is the bundled demo directory. The built-in simulators drive it, so it can't be deleted while DEMO_MODE is on."
                : "Deleting this directory removes its id mappings and invalidates its proxy token immediately."}
            </Text>
          </Flex>
          <AlertDialog.Root>
            <AlertDialog.Trigger>
              <Button color="red" disabled={isDemoDirectory}>
                Delete directory
              </Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content size="2">
              <Form method="post">
                <Flex direction="column" gap="5">
                  <AlertDialog.Header
                    title="Delete this directory?"
                    description={`This permanently deletes "${directory.name}" and its id mappings. The IdP will start receiving 401 responses from the proxy as soon as the token is gone.`}
                  />
                  <input type="hidden" name="intent" value="delete-directory" />
                  <AlertDialog.Footer>
                    <AlertDialog.Cancel>
                      <Button>Cancel</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button color="red" type="submit">
                        Delete directory
                      </Button>
                    </AlertDialog.Action>
                  </AlertDialog.Footer>
                </Flex>
              </Form>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Flex>
      </Card>
    </Flex>
  );
}

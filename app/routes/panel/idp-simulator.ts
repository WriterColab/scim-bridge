import { getConfig } from "../../../workers/shared/db";
import type { Datastore } from "../../../workers/shared/datastore";
import { simulatorHttpFetch } from "../../../workers/shared/http-clients";

const DEFAULT_IDP_URL = "http://localhost:8789";

/**
 * Forward a command to the IdP simulator worker (seed / reset / auto / action).
 * Shared by the IdP simulator tab and the Live state cockpit so both drive the
 * simulator the same way. Never redirects — callers return the result as
 * action data so the page revalidates in place.
 */
export async function callIdpSimulator(
  db: Datastore,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const base = ((await getConfig(db, "idp.public_url")) ?? DEFAULT_IDP_URL).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await simulatorHttpFetch(`${base}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      error: `The IdP simulator was unreachable — ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    return { ok: false, error: data.error ?? "The IdP simulator rejected that request." };
  }
  return { ok: true };
}

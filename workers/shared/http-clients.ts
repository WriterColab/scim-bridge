export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ServerHttpClients {
  workos: HttpFetch;
  events: HttpFetch;
  bridge: HttpFetch;
  simulator: HttpFetch;
}

const REGISTRY = Symbol.for("scim-bridge.server-http-clients");
const host = globalThis as unknown as Record<symbol, ServerHttpClients | undefined>;

export function registerServerHttpClients(clients: ServerHttpClients): void {
  host[REGISTRY] = clients;
}

export function workosHttpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return clients().workos(input, init);
}

export function eventsHttpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return clients().events(input, init);
}

export function bridgeHttpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return clients().bridge(input, init);
}

export function simulatorHttpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return clients().simulator(input, init);
}

function clients(): ServerHttpClients {
  const configured = host[REGISTRY];
  if (process.env.NODE_ENV === "test") {
    const testFetch: HttpFetch = (input, init) => globalThis.fetch(input, init);
    return (
      configured ?? {
        workos: testFetch,
        events: testFetch,
        bridge: testFetch,
        simulator: testFetch,
      }
    );
  }
  if (!configured) throw new Error("Server HTTP clients are not configured");
  return configured;
}

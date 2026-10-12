import type { IncomingMessage, ServerResponse } from "node:http";

type RequestListener = (incoming: IncomingMessage, outgoing: ServerResponse) => unknown;

/** A plain `host[:port]` or `[ipv6][:port]`: nothing that could move the path or authority. */
const HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Behind a TLS terminator the socket is plain HTTP, so @hono/node-server builds
 * every request as http:// while the browser used https://. React Router (>= 8.3.1)
 * compares full origins on every panel action and refuses that mismatch with 400.
 *
 * With TRUST_PROXY the proxy's `X-Forwarded-Proto` decides the scheme once, here,
 * by handing the adapter an absolute URL (which it accepts), so every layer sees the
 * URL the browser used and no request is rebuilt later. Only an upgrade to https is
 * adopted, and only for the request's own Host: never a downgrade, never another host.
 */
export function withForwardedProto(listener: RequestListener): RequestListener {
  return (incoming, outgoing) => {
    const host = incoming.headers.host;
    if (
      forwardedProto(incoming.headers["x-forwarded-proto"]) === "https" &&
      incoming.url?.startsWith("/") &&
      host &&
      HOST.test(host)
    ) {
      incoming.url = `https://${host}${incoming.url}`;
    }
    return listener(incoming, outgoing);
  };
}

/** The scheme the client-facing proxy saw: the first entry of a proxy chain. */
function forwardedProto(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(",")[0]?.trim().toLowerCase() || null;
}

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici/index.js";
import type { HttpFetch } from "../workers/shared/http-clients";

type Address = { address: string; family: number };
type TransportOptions = {
  resolve?: (hostname: string) => Promise<readonly Address[]>;
  connect?: buildConnector.connector;
  ca?: string;
};

const blocked = new BlockList();
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addAddress("100.100.100.200", "ipv4");
blocked.addAddress("168.63.129.16", "ipv4");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addAddress("fd00:ec2::254", "ipv6");
blocked.addAddress("fd20:ce::254", "ipv6");
blocked.addAddress("0.0.0.0", "ipv4");
blocked.addAddress("::", "ipv6");

export function createTrustedHttpTransport({
  resolve = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  connect,
  ca,
}: TransportOptions = {}) {
  const dial = connect ?? buildConnector({ timeout: 5_000, ...(ca ? { ca } : {}) });
  const dispatcher = new Agent({
    connect(options, callback) {
      const hostname = options.hostname.replace(/^\[|\]$/g, "");
      if (options.socketPath || options.httpSocket) {
        callback(new TypeError("HTTP requires a TCP connection"), null);
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const addresses = isIP(hostname)
        ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
        : resolve(hostname);
      void Promise.race([
        addresses,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("HTTP DNS resolution timed out")), 5_000);
        }),
      ]).then(
        (answers) => {
          clearTimeout(timeout);
          const [first] = answers;
          if (!first || answers.some(({ address }) => !isMetadataSafe(address))) {
            callback(new TypeError("HTTP destination is forbidden"), null);
            return;
          }
          dial(
            {
              ...options,
              hostname: first.address,
              host: hostname,
              servername: isIP(hostname) ? undefined : hostname,
            },
            callback,
          );
        },
        (cause: unknown) => {
          clearTimeout(timeout);
          callback(cause instanceof Error ? cause : new Error("HTTP DNS failed", { cause }), null);
        },
      );
    },
  });

  const fetch: HttpFetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const hostname = url.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /^(metadata|instance-data)(\.|$)/.test(hostname) ||
      (isIP(hostname) && !isMetadataSafe(hostname))
    )
      throw new TypeError("HTTP destination is forbidden");
    request.headers.set("host", url.host);
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body,
      signal: request.signal,
      duplex: "half",
      redirect: "manual",
      dispatcher,
    });
    const reader = response.body?.getReader();
    let removeAbortListener = () => {};
    const body = reader
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => {
              controller.error(request.signal.reason);
              void reader.cancel(request.signal.reason).catch(() => {});
            };
            request.signal.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => request.signal.removeEventListener("abort", abort);
            if (request.signal.aborted) abort();
          },
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                removeAbortListener();
                reader.releaseLock();
                controller.close();
              } else {
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              removeAbortListener();
              reader.releaseLock();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              removeAbortListener();
              reader.releaseLock();
            }
          },
        })
      : null;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  };
  return { fetch, close: () => dispatcher.close() };
}

export function restrictOrigins(httpFetch: HttpFetch, origins: readonly string[]): HttpFetch {
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  return async (input, init) => {
    const request = new Request(input, init);
    if (!allowed.has(new URL(request.url).origin))
      throw new TypeError("HTTP origin is not trusted");
    return httpFetch(request);
  };
}

function isMetadataSafe(address: string): boolean {
  const family = isIP(address);
  const mappedIpv4 = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return (
    family !== 0 &&
    !address.includes("%") &&
    !blocked.check(address, family === 4 ? "ipv4" : "ipv6") &&
    (!mappedIpv4 || !blocked.check(mappedIpv4, "ipv4"))
  );
}

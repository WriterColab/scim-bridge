import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedHttpTransport, restrictOrigins } from "../server/http-transport";

const transports: { close(): Promise<void> }[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("trusted HTTP transport", () => {
  it("connects to the checked address and preserves the original Host", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NO_PROXY", "writer-egress.test");
    const port = await listen((request, response) => response.end(request.headers.host));
    const transport = createTrustedHttpTransport({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    transports.push(transport);

    const response = await transport.fetch(`http://writer-egress.test:${port}/`);

    expect(await response.text()).toBe(`writer-egress.test:${port}`);
  });

  it.each(["169.254.169.254", "fd00:ec2::254", "::ffff:169.254.169.254"])(
    "rejects metadata address %s",
    async (address) => {
      const transport = createTrustedHttpTransport({
        resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      });
      transports.push(transport);

      await expect(transport.fetch("http://writer-egress.test/")).rejects.toMatchObject({
        cause: { message: "HTTP destination is forbidden" },
      });
    },
  );

  it("rejects mixed DNS answers before connecting", async () => {
    const transport = createTrustedHttpTransport({
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    transports.push(transport);

    await expect(transport.fetch("http://writer-egress.test/")).rejects.toMatchObject({
      cause: { message: "HTTP destination is forbidden" },
    });
  });

  it("does not follow redirects", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    });
    const transport = createTrustedHttpTransport({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    transports.push(transport);

    const response = await transport.fetch(`http://writer-egress.test:${port}/`);

    expect(response.status).toBe(302);
  });

  it("restricts each client to its wired origin", async () => {
    const transport = createTrustedHttpTransport();
    transports.push(transport);
    const client = restrictOrigins(transport.fetch, ["https://api.workos.com"]);

    await expect(client("https://example.com/")).rejects.toThrow("HTTP origin is not trusted");
  });
});

async function listen(
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not listen");
  return address.port;
}

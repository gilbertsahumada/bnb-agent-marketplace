import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import {
  parseOutputPath,
  verificationExitCode,
  writeVerificationReport,
} from "../src/verification/cli.js";
import {
  assertSafeMcpEndpoint,
  isPublicIpAddress,
  verifyMcpEndpoint,
} from "../src/verification/mcp.js";
import {
  createPinnedLookup,
  resolveSafePublicHttpsEndpoint,
} from "../src/verification/safe-http.js";
import { ViemBscIdentityReader, type BscIdentityReader } from "../src/verification/onchain.js";
import { buildBscVerificationReport } from "../src/verification/report.js";
import type { McpEndpointVerification } from "../src/verification/types.js";
import { Trust8004Provider } from "../src/trust8004/provider.js";

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8")) as unknown;
}

function trustFixtureFetch(
  list: unknown,
  profiles: Record<string, unknown>,
  scores: Record<string, unknown>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v2/agents") return Response.json(list);
    if (url.pathname === "/api/v2/agents/profile") {
      const profile = profiles[url.searchParams.get("agentId") ?? ""];
      return profile ? Response.json(profile) : new Response("not found", { status: 404 });
    }
    const match = url.pathname.match(/^\/api\/v2\/agents\/(\d+)\/score$/);
    const score = match ? scores[match[1]!] : undefined;
    return score ? Response.json(score) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("MCP verification", () => {
  it("uses the official handshake, follows tools pagination, and never invokes a tool", async () => {
    const methods: string[] = [];
    const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        id?: number;
        params?: { cursor?: string };
      };
      methods.push(body.method);
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "sanitized-mcp", version: "1.0.0" },
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const secondPage = body.params?.cursor === "page-2";
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [{
            name: secondPage ? "observedOnly" : "matchedTool",
            description: "Sanitized read-only fixture",
            inputSchema: { type: "object" },
          }],
          ...(secondPage ? {} : { nextCursor: "page-2" }),
        },
      });
    }) as typeof fetch;

    const result = await verifyMcpEndpoint(
      "https://fixture.example/mcp",
      ["matchedTool", "declaredOnly"],
      {
        fetch: mockFetch,
        resolveHostname: async () => ["93.184.216.34"],
        now: () => 1_754_000_300_000,
      },
    );

    expect(result).toMatchObject({
      status: "protocol_valid",
      negotiatedProtocolVersion: "2025-06-18",
      serverInfo: { name: "sanitized-mcp", version: "1.0.0" },
      comparison: {
        matched: ["matchedTool"],
        declaredOnly: ["declaredOnly"],
        observedOnly: ["observedOnly"],
      },
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
    ]);
    expect(methods).not.toContain("tools/call");
  });

  it("rejects unsafe targets without making a request", async () => {
    let calls = 0;
    const result = await verifyMcpEndpoint("https://127.0.0.1/mcp", [], {
      fetch: (async () => { calls += 1; return Response.json({}); }) as typeof fetch,
    });
    expect(result.status).toBe("unsafe_url");
    expect(calls).toBe(0);
    await expect(assertSafeMcpEndpoint("http://example.com/mcp")).rejects.toThrow("HTTPS");
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
  });

  it("pins the validated public address instead of resolving DNS again", async () => {
    let resolutions = 0;
    const resolved = await resolveSafePublicHttpsEndpoint(
      "https://fixture.example/mcp",
      async () => {
        resolutions += 1;
        return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
    );
    const pinnedLookup = createPinnedLookup(resolved.addresses);
    const connect = () => new Promise<string>((resolveAddress, reject) => {
      pinnedLookup("fixture.example", { family: 4, all: false }, (error, address) => {
        if (error) reject(error);
        else if (typeof address === "string") resolveAddress(address);
        else reject(new Error("Pinned lookup returned an unexpected address shape"));
      });
    });

    await expect(connect()).resolves.toBe("93.184.216.34");
    await expect(connect()).resolves.toBe("93.184.216.34");
    expect(resolutions).toBe(1);
  });

  it("classifies request timeouts without exposing raw details", async () => {
    const result = await verifyMcpEndpoint("https://fixture.example/mcp", [], {
      resolveHostname: async () => ["93.184.216.34"],
      fetch: (async () => { throw new DOMException("sensitive timeout detail", "TimeoutError"); }) as typeof fetch,
    });
    expect(result).toMatchObject({
      status: "timeout",
      error: { code: "MCP_TIMEOUT", message: "Endpoint request timed out." },
    });
  });

  it("reports authentication requirements without attempting credentials", async () => {
    const result = await verifyMcpEndpoint("https://fixture.example/mcp", [], {
      resolveHostname: async () => ["93.184.216.34"],
      fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    expect(result).toMatchObject({
      status: "unauthorized",
      error: { code: "MCP_UNAUTHORIZED", message: "Endpoint requires authentication." },
    });
  });
});

describe("BSC verification report", () => {
  it("keeps ownerOf and getAgentWallet distinct", async () => {
    const owner = "0x1111111111111111111111111111111111111111" as Address;
    const agentWallet = "0x2222222222222222222222222222222222222222" as Address;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "getAgentWallet") return agentWallet;
        return "ipfs://sanitized/agent";
      },
    } as unknown as PublicClient;
    const reader = new ViemBscIdentityReader(
      client,
      "0x5555555555555555555555555555555555555555",
    );

    await expect(reader.readIdentity("45650", 123n)).resolves.toEqual({
      owner,
      agentWallet,
      metadataUri: "ipfs://sanitized/agent",
    });
  });

  it("keeps declared, observed, and onchain evidence separate", async () => {
    const [list, profiles, scores, onchain] = await Promise.all([
      fixture("trust8004/list.json"),
      fixture("trust8004/profiles.json") as Promise<Record<string, unknown>>,
      fixture("trust8004/scores.json") as Promise<Record<string, unknown>>,
      fixture("verification/onchain.json") as Promise<{
        registryAddress: Address;
        blockNumber: string;
        agents: Record<string, { owner: Address; agentWallet: Address; metadataUri: string }>;
      }>,
    ]);
    const provider = new Trust8004Provider({
      fetch: trustFixtureFetch(list, profiles, scores),
      minimumRequestIntervalMs: 0,
    });
    const identityReader: BscIdentityReader = {
      registryAddress: onchain.registryAddress,
      assertChain: async () => undefined,
      getBlockNumber: async () => BigInt(onchain.blockNumber),
      readIdentity: async (agentId) => {
        const identity = onchain.agents[agentId];
        if (!identity) throw new Error("missing sanitized identity");
        return identity;
      },
    };
    const fakeMcp = async (endpoint: string, declaredTools: string[]): Promise<McpEndpointVerification> => {
      const observedTools = endpoint.endsWith("/beefy")
        ? [...declaredTools, "newObservedTool"]
        : [...declaredTools];
      return {
        status: "protocol_valid",
        endpoint,
        protocol: "mcp",
        declaredTools: [...declaredTools].sort(),
        observedTools: [...observedTools].sort(),
        comparison: {
          matched: [...declaredTools].sort(),
          declaredOnly: [],
          observedOnly: endpoint.endsWith("/beefy") ? ["newObservedTool"] : [],
        },
        negotiatedProtocolVersion: "2025-06-18",
        serverInfo: { name: "sanitized-mcp", version: "1.0.0" },
        latencyMs: 5,
        observedAt: "2025-08-01T00:00:00.000Z",
        provenance: "observed:mcp-tools-list",
        error: null,
      };
    };
    const report = await buildBscVerificationReport({
      provider,
      identityReader,
      verifyMcp: fakeMcp,
      now: () => 1_754_000_300_000,
    });

    expect(report.summary).toMatchObject({
      status: "attention_required",
      agentsTotal: 4,
      identityMatches: 3,
      identityAttention: 1,
      endpointsValid: 4,
      toolDriftEndpoints: 1,
    });
    const beefy = report.agents.find((agent) => agent.agentId === "45422");
    expect(beefy?.identity).toMatchObject({
      status: "mismatch",
      declared: { provenance: "declared:trust8004-public-api" },
      onchain: { provenance: "onchain:bsc-rpc" },
      checks: { ownerMatches: true, metadataUriMatches: false },
    });
    expect(beefy?.mcpEndpoints[0]?.provenance).toBe("observed:mcp-tools-list");
    expect(beefy?.hireability).toBe("not_assessed");
    expect(report.categories.grid_trading).toMatchObject({ status: "unverified", agentIds: [] });
    expect(verificationExitCode(report)).toBe(2);
    expect(verificationExitCode({
      ...report,
      summary: { ...report.summary, status: "complete" },
    })).toBe(0);

    const directory = await mkdtemp(join(tmpdir(), "bsc-verification-"));
    try {
      const destination = join(directory, "report.json");
      await writeVerificationReport(destination, report);
      expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({ schemaVersion: 1, chainId: 56 });
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      await expect(stat(`${destination}.tmp`)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records an individual onchain read failure instead of inventing identity", async () => {
    const [list, profiles, scores] = await Promise.all([
      fixture("trust8004/list.json"),
      fixture("trust8004/profiles.json") as Promise<Record<string, unknown>>,
      fixture("trust8004/scores.json") as Promise<Record<string, unknown>>,
    ]);
    const report = await buildBscVerificationReport({
      provider: new Trust8004Provider({
        fetch: trustFixtureFetch(list, profiles, scores),
        minimumRequestIntervalMs: 0,
      }),
      identityReader: {
        registryAddress: "0x5555555555555555555555555555555555555555",
        assertChain: async () => undefined,
        getBlockNumber: async () => 99n,
        readIdentity: async () => { throw new Error("RPC https://secret.invalid?token=value failed"); },
      },
      verifyMcp: async (endpoint, declaredTools) => ({
        status: "protocol_valid",
        endpoint,
        protocol: "mcp",
        declaredTools,
        observedTools: declaredTools,
        comparison: { matched: declaredTools, declaredOnly: [], observedOnly: [] },
        negotiatedProtocolVersion: "2025-06-18",
        serverInfo: null,
        latencyMs: 1,
        observedAt: "2025-08-01T00:00:00.000Z",
        provenance: "observed:mcp-tools-list",
        error: null,
      }),
    });
    expect(report.agents.every((agent) => agent.identity.status === "read_error")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret.invalid");
    expect(JSON.stringify(report)).not.toContain("token=value");
  });

  it("validates CLI arguments", () => {
    expect(parseOutputPath([])).toMatch(/\.marketplace\/verification\/bsc-candidates\.json$/);
    expect(parseOutputPath(["--output", "custom.json"])).toMatch(/custom\.json$/);
    expect(() => parseOutputPath(["--unknown"])).toThrow("Unknown argument");
    expect(() => parseOutputPath(["--output"])).toThrow("requires a file path");
  });
});

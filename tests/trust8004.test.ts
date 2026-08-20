import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildBscCandidateInventory,
  KNOWN_HEYANON_AGENT_IDS,
  MAX_EXPLICIT_QUALIFICATION_AGENT_IDS,
} from "../src/trust8004/inventory.js";
import { Trust8004Provider } from "../src/trust8004/provider.js";
import {
  parseAgentListResponse,
  parseServices,
  Trust8004SchemaError,
} from "../src/trust8004/schemas.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/trust8004/${name}`, import.meta.url), "utf8")) as unknown;
}

function fixtureFetch(
  list: unknown,
  profiles: Record<string, unknown>,
  scores: Record<string, unknown>,
  onRequest?: (url: URL) => Promise<void> | void,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    await onRequest?.(url);
    let body: unknown;
    if (url.pathname === "/api/v2/agents") body = list;
    else if (url.pathname === "/api/v2/agents/profile") body = profiles[url.searchParams.get("agentId") ?? ""];
    else {
      const match = url.pathname.match(/^\/api\/v2\/agents\/(\d+)\/score$/);
      body = match ? scores[match[1]!] : undefined;
    }
    return body === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(body);
  }) as typeof fetch;
}

async function allFixtures(): Promise<{
  list: unknown;
  profiles: Record<string, unknown>;
  scores: Record<string, unknown>;
}> {
  return {
    list: await fixture("list.json"),
    profiles: await fixture("profiles.json") as Record<string, unknown>,
    scores: await fixture("scores.json") as Record<string, unknown>,
  };
}

describe("Trust8004Provider", () => {
  it("normalizes services supplied as a JSON string or an array", () => {
    const service = { name: "MCP", endpoint: "https://fixture.invalid/mcp", tools: ["quote"] };
    expect(parseServices(JSON.stringify([service]))).toEqual(parseServices([service]));
  });

  it("lists only BSC agents with explicit pagination and partial coverage", async () => {
    const data = await allFixtures();
    let requestedUrl: URL | undefined;
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, data.profiles, data.scores, (url) => { requestedUrl = url; }),
      minimumRequestIntervalMs: 0,
      now: () => 1_754_000_300_000,
    });
    const page = await provider.listAgents({ limit: 50, offset: 0, search: "grid", active: true });

    expect(page.catalogCoverage).toBe("partial");
    expect(requestedUrl?.searchParams.get("chainId")).toBe("56");
    expect(requestedUrl?.searchParams.get("limit")).toBe("50");
    expect(requestedUrl?.searchParams.get("offset")).toBe("0");
    expect(requestedUrl?.searchParams.get("search")).toBe("grid");
  });

  it("parses the enriched list summary and requests supported server-side options", async () => {
    const list = {
      items: [{
        chainId: 56,
        agentId: "45650",
        name: "V3 Pools powered by HeyAnon",
        description: "Rebalancing",
        ownerAddress: "0x1111111111111111111111111111111111111111",
        ipfsUri: "ipfs://sanitized/45650",
        mcpEndpoint: "https://fixture.invalid/mcp",
        a2aEndpoint: null,
        services: JSON.stringify([{ name: "MCP", endpoint: "https://fixture.invalid/mcp", tools: ["rebalance"] }]),
        endpoints: [],
        skills: [],
        capabilities: null,
        endpointHealth: null,
        trustScore: 72,
        trustTier: "Silver",
        active: true,
        updatedAt: 1_754_000_100_000,
      }],
      total: 1,
      limit: 24,
      offset: 0,
      reputations: { "56:45650": { count: 3, averageScore: 84 } },
    };
    let requestedUrl: URL | undefined;
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(list, {}, {}, (url) => { requestedUrl = url; }),
      minimumRequestIntervalMs: 0,
      now: () => 1_754_000_300_000,
    });

    const page = await provider.listAgents({
      view: "all",
      q: "HeyAnon",
      limit: 24,
      includeReputation: true,
      sortBy: "score",
      sortOrder: "desc",
    });

    expect(requestedUrl?.searchParams.get("view")).toBe("all");
    expect(requestedUrl?.searchParams.get("search")).toBe("HeyAnon");
    expect(requestedUrl?.searchParams.get("includeReputation")).toBe("true");
    expect(requestedUrl?.searchParams.get("sortBy")).toBe("score");
    expect(page.items[0]).toMatchObject({
      agentId: "45650",
      owner: "0x1111111111111111111111111111111111111111",
      metadataUri: "ipfs://sanitized/45650",
      tools: ["rebalance"],
      reputation: { totalFeedbacks: 3, averageScore: 84 },
      trustScore: { total: 72, tier: "Silver" },
    });
  });

  it("deduplicates identical requests and serializes distinct requests", async () => {
    const data = await allFixtures();
    let requestCount = 0;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, data.profiles, data.scores, async () => {
        requestCount += 1;
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeRequests -= 1;
      }),
      minimumRequestIntervalMs: 0,
    });

    await Promise.all([provider.listAgents(), provider.listAgents()]);
    expect(requestCount).toBe(1);
    await provider.listAgents();
    expect(requestCount).toBe(2);
    await Promise.all([provider.getProfile("45650"), provider.getTrustScore("45650")]);
    expect(maximumActiveRequests).toBe(1);
  });

  it("builds a deterministic partial inventory containing all four known HeyAnon agents", async () => {
    const data = await allFixtures();
    const requestedPaths: string[] = [];
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, data.profiles, data.scores, (url) => {
        requestedPaths.push(url.pathname);
      }),
      minimumRequestIntervalMs: 0,
    });
    const inventory = await buildBscCandidateInventory(provider, () => 1_754_000_300_000);

    expect(inventory.chainId).toBe(56);
    expect(inventory.schemaVersion).toBe(2);
    expect(inventory.selection).toEqual({
      curatedAgentIds: KNOWN_HEYANON_AGENT_IDS,
      explicitAgentIds: [],
      evaluatedAgentIds: KNOWN_HEYANON_AGENT_IDS,
    });
    expect(inventory.source.catalogCoverage).toBe("partial");
    expect(inventory.agents.map((agent) => agent.agentId)).toEqual(KNOWN_HEYANON_AGENT_IDS);
    expect(inventory.categories.rebalancing.agentIds).toContain("45650");
    expect(inventory.categories.yield_optimisation.agentIds).toEqual(expect.arrayContaining(["45422", "43129"]));
    expect(inventory.categories.health_factor_monitoring.agentIds).toEqual(expect.arrayContaining(["45381", "43129"]));
    expect(inventory.categories.grid_trading).toMatchObject({ status: "unverified", agentIds: [] });
    expect(inventory.agents.every((agent) => agent.endpointObservation.status === "not_observed")).toBe(true);
    expect(inventory.agents.every((agent) => agent.provenance.services.kind === "declared")).toBe(true);
    expect(inventory.agents.every((agent) => agent.categories.every((category) => !category.verified))).toBe(true);
    expect(requestedPaths).not.toContain("/api/v2/agents");
  });

  it("evaluates explicit IDs without adding them to curated categories", async () => {
    const data = await allFixtures();
    const profiles = structuredClone(data.profiles);
    const scores = structuredClone(data.scores);
    profiles["999"] = structuredClone(profiles["45650"]);
    scores["999"] = structuredClone(scores["45650"]);
    (profiles["999"] as { agent: { agentId: string; name: string } }).agent.agentId = "999";
    (profiles["999"] as { agent: { agentId: string; name: string } }).agent.name = "Explicit seller candidate";
    (scores["999"] as { agentId: string }).agentId = "999";
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, profiles, scores),
      minimumRequestIntervalMs: 0,
    });
    const inventory = await buildBscCandidateInventory(provider, Date.now, {
      additionalAgentIds: ["0999", "999", "45650"],
    });

    expect(inventory.selection.explicitAgentIds).toEqual(["999"]);
    expect(inventory.selection.evaluatedAgentIds).toEqual([...KNOWN_HEYANON_AGENT_IDS, "999"]);
    expect(inventory.agents.at(-1)?.agentId).toBe("999");
    expect(inventory.agents.at(-1)?.categories).toEqual([]);
    expect(Object.values(inventory.categories).every((category) => !category.agentIds.includes("999"))).toBe(true);
  });

  it("bounds explicit qualification IDs", async () => {
    const data = await allFixtures();
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, data.profiles, data.scores),
      minimumRequestIntervalMs: 0,
    });
    const ids = Array.from({ length: MAX_EXPLICIT_QUALIFICATION_AGENT_IDS + 1 }, (_, index) => String(index + 1));
    await expect(buildBscCandidateInventory(provider, Date.now, { additionalAgentIds: ids }))
      .rejects.toThrow(`At most ${MAX_EXPLICIT_QUALIFICATION_AGENT_IDS}`);
  });

  it("fails visibly with a diagnostic path when a response violates the schema", async () => {
    const data = await allFixtures();
    const invalidProfiles = structuredClone(data.profiles);
    const invalid = invalidProfiles["45650"] as { agent: { services: unknown } };
    invalid.agent.services = "not-json";
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, invalidProfiles, data.scores),
      minimumRequestIntervalMs: 0,
    });

    await expect(provider.getProfile("45650")).rejects.toThrow(/response\.agent\.services: invalid JSON string/);
  });

  it("rejects a non-BSC response instead of silently accepting it", async () => {
    const data = await allFixtures();
    const invalidProfiles = structuredClone(data.profiles);
    const invalid = invalidProfiles["45650"] as { agent: { chainId: unknown } };
    invalid.agent.chainId = 97;
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, invalidProfiles, data.scores),
      minimumRequestIntervalMs: 0,
    });

    await expect(provider.getProfile("45650")).rejects.toBeInstanceOf(Trust8004SchemaError);
  });

  it("rejects profile and score payloads for a different requested agent", async () => {
    const data = await allFixtures();
    const profiles = structuredClone(data.profiles);
    const scores = structuredClone(data.scores);
    (profiles["45650"] as { agent: { agentId: string } }).agent.agentId = "45381";
    (scores["45381"] as { agentId: string }).agentId = "45650";
    const provider = new Trust8004Provider({
      fetch: fixtureFetch(data.list, profiles, scores),
      minimumRequestIntervalMs: 0,
    });

    await expect(provider.getProfile("45650")).rejects.toThrow(/response\.agent\.agentId/);
    await expect(provider.getTrustScore("45381")).rejects.toThrow(/response\.agentId/);
  });

  it.each([
    { field: "total", value: -1 },
    { field: "limit", value: 0 },
    { field: "limit", value: 1.5 },
    { field: "limit", value: 101 },
    { field: "offset", value: -1 },
  ])("rejects invalid pagination semantics for $field=$value", ({ field, value }) => {
    const response = {
      items: [],
      total: 0,
      limit: 24,
      offset: 0,
      [field]: value,
    };
    expect(() => parseAgentListResponse(response)).toThrow(Trust8004SchemaError);
  });

  it("aborts slow requests and rejects oversized responses", async () => {
    const slowFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const slowProvider = new Trust8004Provider({
      fetch: slowFetch,
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 5,
    });
    await expect(slowProvider.listAgents()).rejects.toThrow();

    const oversizedProvider = new Trust8004Provider({
      fetch: (async () => new Response("01234567890")) as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxResponseBytes: 10,
    });
    await expect(oversizedProvider.listAgents()).rejects.toThrow(/exceeded 10 bytes/);
  });
});

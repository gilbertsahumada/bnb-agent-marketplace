import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStatus, NegotiationRequest, type Job } from "@bnbagent/sdk/erc8183";
import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, PublicClient } from "viem";
import {
  parseReadinessArgs,
  parseOutputPath,
  readinessFatalMessage,
  readinessExitCode,
  writeReadinessReport,
} from "../src/readiness/cli.js";
import type { Gate1ProofReader } from "../src/readiness/gate1.js";
import { verifyGate1Proof } from "../src/readiness/gate1.js";
import { createHireabilityAssessor } from "../src/readiness/protocols.js";
import { buildBscMarketplaceReadinessReport } from "../src/readiness/report.js";
import type { HireabilityAssessment } from "../src/readiness/types.js";
import { KNOWN_HEYANON_AGENT_IDS } from "../src/trust8004/inventory.js";
import { Trust8004HttpError, Trust8004Provider } from "../src/trust8004/provider.js";
import type { MarketplaceAgent } from "../src/trust8004/types.js";
import type { BscIdentityReader } from "../src/verification/onchain.js";
import type { IdentityVerification, McpEndpointVerification } from "../src/verification/types.js";

const PROVIDER = "0x1111111111111111111111111111111111111111" as Address;
const PAYMENT_TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const COMMERCE = "0x3333333333333333333333333333333333333333" as Address;
const ROUTER = "0x4444444444444444444444444444444444444444" as Address;
const POLICY = "0x5555555555555555555555555555555555555555" as Address;

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8")) as unknown;
}

function identity(agentWallet: Address | null = PROVIDER): IdentityVerification {
  return {
    status: agentWallet ? "match" : "read_error",
    declared: {
      owner: PROVIDER,
      metadataUri: "ipfs://sanitized/agent",
      provenance: "declared:trust8004-public-api",
    },
    onchain: {
      owner: agentWallet,
      agentWallet,
      metadataUri: agentWallet ? "ipfs://sanitized/agent" : null,
      registryAddress: "0x4444444444444444444444444444444444444444",
      blockNumber: "123",
      provenance: "onchain:bsc-rpc",
    },
    checks: { ownerMatches: agentWallet !== null, metadataUriMatches: agentWallet !== null },
    observedAt: "2026-08-17T00:00:00.000Z",
    error: null,
  };
}

function agent(services: MarketplaceAgent["services"]): MarketplaceAgent {
  return {
    chainId: 56,
    agentId: "1",
    name: "Sanitized agent",
    description: "Deterministic fixture",
    owner: PROVIDER,
    metadataUri: "ipfs://sanitized/agent",
    services,
    endpoints: services.flatMap((service) => service.endpoint
      ? [{ name: service.name, endpoint: service.endpoint }]
      : []),
    tools: services.flatMap((service) => service.tools),
    capabilities: [],
    reputation: { totalFeedbacks: 0, averageScore: null, uniqueReviewers: 0 },
    trustScore: {
      total: 0,
      tier: "unrated",
      dimensions: {},
      calculatedAt: "2026-08-17T00:00:00.000Z",
      expiresAt: "2026-08-18T00:00:00.000Z",
    },
    categories: [],
    endpointObservation: {
      status: "not_observed",
      protocol: null,
      endpoint: null,
      lastTestedAt: null,
      httpStatus: null,
      capabilitiesCount: 0,
      requiresAuth: null,
      error: null,
    },
    freshness: {
      fetchedAt: "2026-08-17T00:00:00.000Z",
      metadataUpdatedAt: null,
      indexedUpdatedAt: null,
    },
    catalogCoverage: "partial",
    provenance: {
      identity: { kind: "onchain", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      metadata: { kind: "declared", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      services: { kind: "declared", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      endpointObservation: { kind: "observed", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      reputation: { kind: "onchain", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      trustScore: { kind: "derived", source: "trust8004-public-api", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
      categories: { kind: "derived", source: "marketplace", sourcePath: "fixture", fetchedAt: "2026-08-17T00:00:00.000Z", verifiedDirectly: false },
    },
  };
}

function assessorOptions(fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    resolveHostname: async () => ["93.184.216.34"],
    now: () => 1_950_000_000_000,
    createQuoteContext: async () => ({
      chainId: 56 as const,
      commerce: COMMERCE,
      router: ROUTER,
      policy: POLICY,
      paymentToken: PAYMENT_TOKEN,
      policyAllowlisted: true,
      publicClient: {} as PublicClient,
    }),
    verifyQuote: async () => ({ valid: true as const, method: "eip191" as const, signer: PROVIDER }),
  };
}

function quoteVerifiedAssessment(provider: Address = PROVIDER): HireabilityAssessment {
  return {
    transport: "a2a",
    declaredSellerProtocols: ["a2a"],
    quoteStatus: "verified",
    hireability: "quote_verified",
    protocols: [{
      transport: "a2a",
      endpoint: "https://fixture.example/a2a",
      status: "quote_verified",
      quoteStatus: "verified",
      agentCardSkills: ["negotiate-erc8183-job", "notify_funded"],
      healthObserved: null,
      statusObserved: null,
      quote: {
        provider,
        price: "1",
        currency: PAYMENT_TOKEN,
        verifyingContract: COMMERCE,
        contractContext: {
          chainId: 56,
          commerce: COMMERCE,
          router: ROUTER,
          policy: POLICY,
          paymentToken: PAYMENT_TOKEN,
          policyAllowlisted: true,
          provenance: "configured:bnbagent-sdk+onchain:bsc-mainnet-rpc",
        },
        negotiationHash: `0x${"c".repeat(64)}`,
        signatureMethod: "eip191",
        negotiatedAt: 1_949_999_970,
        quoteExpiresAt: 1_950_000_600,
        observedAt: "2031-10-17T10:40:00.000Z",
        provenance: "observed:erc8183-signed-quote",
      },
      observedAt: "2031-10-17T10:40:00.000Z",
      provenance: "declared:trust8004-public-api+observed:marketplace-probe",
      error: null,
    }],
    probe: { totalDeclaredEndpoints: 1, evaluatedEndpoints: 1, skippedEndpoints: 0, truncated: false },
    note: "Signed quote verified.",
    provenance: "derived:marketplace-readiness",
  };
}

describe("ERC-8183 readiness protocols", () => {
  it("classifies MCP without probing guessed seller routes", async () => {
    const fetchImpl = vi.fn();
    const assess = createHireabilityAssessor(assessorOptions(fetchImpl as unknown as typeof fetch));
    const result = await assess(agent([{
      name: "MCP",
      endpoint: "https://fixture.example/mcp",
      version: null,
      tools: ["readOnlyTool"],
      capabilities: ["tools"],
    }]), identity());
    expect(result).toMatchObject({ transport: "mcp_only", hireability: "mcp_only", quoteStatus: "not_applicable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates an A2A Agent Card and signed quote without calling notify_funded", async () => {
    const quote = await fixture("readiness/quote.json");
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Response.json({
          name: "Sanitized seller",
          url: "https://fixture.example/a2a",
          skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }],
        });
      }
      const body = JSON.parse(String(init.body)) as { params: { message: { parts: Array<{ data: { skill: string } }> } } };
      methods.push(body.params.message.parts[0]!.data.skill);
      return Response.json({ result: { parts: [{ data: quote }] } });
    }) as unknown as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(fetchImpl))(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ transport: "a2a", hireability: "quote_verified", quoteStatus: "verified" });
    expect(result.protocols[0]?.quote).toMatchObject({
      provider: PROVIDER,
      price: "1",
      currency: PAYMENT_TOKEN,
      verifyingContract: COMMERCE,
      contractContext: {
        chainId: 56,
        commerce: COMMERCE,
        router: ROUTER,
        policy: POLICY,
        paymentToken: PAYMENT_TOKEN,
        policyAllowlisted: true,
      },
      negotiatedAt: 1_949_999_970,
      quoteExpiresAt: 1_950_000_600,
    });
    expect(methods).toEqual(["negotiate-erc8183-job"]);
  });

  it("uses only the declared HTTP ERC-8183 route family", async () => {
    const quote = await fixture("readiness/quote.json");
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/negotiate")) return Response.json(quote);
      if (url.pathname.endsWith("/health")) return Response.json({ status: "ok", service: "ERC-8183 Agent" });
      return Response.json({
        status: "ok",
        agent_address: PROVIDER,
        commerce_address: COMMERCE,
        router_address: "0x4444444444444444444444444444444444444444",
        policy_address: "0x5555555555555555555555555555555555555555",
        service_price: "1",
        currency: PAYMENT_TOKEN,
        decimals: 18,
      });
    }) as unknown as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(fetchImpl))(
      agent([{ name: "ERC-8183", endpoint: "https://fixture.example/erc8183/status", version: "0.1.0", tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ transport: "erc8183_http", hireability: "quote_verified" });
    expect(paths).toEqual([
      "GET /erc8183/health",
      "GET /erc8183/status",
      "POST /erc8183/negotiate",
    ]);
    expect(paths.every((path) => !path.includes("agent-card"))).toBe(true);
  });

  it("cancels oversized chunked HTTP ERC-8183 responses before buffering them", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(70_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(body, {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(fetchImpl))(
      agent([{ name: "ERC-8183", endpoint: "https://fixture.example/erc8183", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
    expect(result.protocols[0]?.error?.message).toContain("exceeded the allowed size");
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["chain", (quote: Record<string, unknown>) => { quote.chain_id = 97; }, "chain_id"],
    ["provider", (quote: Record<string, unknown>) => {
      quote.provider_address = "0x9999999999999999999999999999999999999999";
    }, "provider_address"],
    ["Commerce contract", (quote: Record<string, unknown>) => {
      quote.verifying_contract = "0x9999999999999999999999999999999999999999";
    }, "Commerce"],
    ["payment token", (quote: Record<string, unknown>) => {
      const response = quote.response as Record<string, unknown>;
      (response.terms as Record<string, unknown>).currency = "0x9999999999999999999999999999999999999999";
    }, "payment token"],
  ])("fails visibly when quote %s does not match BSC Mainnet", async (_name, mutate, expectedMessage) => {
    const quote = structuredClone(await fixture("readiness/quote.json")) as Record<string, unknown>;
    mutate(quote);
    const fetchImpl = (async () => Response.json({ result: { parts: [{ data: quote }] } })) as typeof fetch;
    const cardFetch = (async (input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? fetchImpl(input, init)
        : Response.json({ name: "seller", url: "https://fixture.example/a2a", skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }] })) as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(cardFetch))(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
    expect(result.protocols[0]?.error?.message).toContain(expectedMessage);
  });

  it("rejects a quote when signature verification fails", async () => {
    const quote = await fixture("readiness/quote.json");
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ result: { parts: [{ data: quote }] } })
        : Response.json({ name: "seller", url: "https://fixture.example/a2a", skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }] })) as typeof fetch;
    const result = await createHireabilityAssessor({
      ...assessorOptions(fetchImpl),
      verifyQuote: async () => ({ valid: false as const, reason: "sanitized invalid signature" }),
    })(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
    expect(result.protocols[0]?.error?.message).toContain("signature rejected");
  });

  it("rejects a self-consistent signed quote for a different request", async () => {
    const quote = structuredClone(await fixture("readiness/quote.json")) as Record<string, unknown>;
    const request = quote.request as Record<string, unknown>;
    request.task_description = "A different signed task";
    quote.request_hash = NegotiationRequest.fromDict(request).computeHash();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ result: { parts: [{ data: quote }] } })
        : Response.json({ name: "seller", url: "https://fixture.example/a2a", skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }] })) as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(fetchImpl))(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
    expect(result.protocols[0]?.error?.message).toContain("does not match the readiness probe");
  });

  it.each([
    ["expired", { negotiated_at: 1_900_000_000, quote_expires_at: 1_950_000_000 }],
    ["future", { negotiated_at: 1_960_000_000, quote_expires_at: 2_000_000_000 }],
    ["stale", { negotiated_at: 1_949_999_900, quote_expires_at: 1_950_000_100 }],
    ["excessive TTL", { negotiated_at: 1_949_999_970, quote_expires_at: 1_950_001_000 }],
  ])("rejects a %s quote timestamp window", async (_name, timestamps) => {
    const quote = structuredClone(await fixture("readiness/quote.json")) as Record<string, unknown>;
    const response = quote.response as Record<string, unknown>;
    response.negotiated_at = timestamps.negotiated_at;
    response.quote_expires_at = timestamps.quote_expires_at;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ result: { parts: [{ data: quote }] } })
        : Response.json({ name: "seller", url: "https://fixture.example/a2a", skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }] })) as typeof fetch;
    const result = await createHireabilityAssessor(assessorOptions(fetchImpl))(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
  });

  it("rejects a quote when the configured Mainnet policy is not allowlisted", async () => {
    const quote = await fixture("readiness/quote.json");
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ result: { parts: [{ data: quote }] } })
        : Response.json({ name: "seller", url: "https://fixture.example/a2a", skills: [{ id: "negotiate-erc8183-job" }, { id: "notify_funded" }] })) as typeof fetch;
    const options = assessorOptions(fetchImpl);
    options.createQuoteContext = async () => ({
      chainId: 56,
      commerce: COMMERCE,
      router: ROUTER,
      policy: POLICY,
      paymentToken: PAYMENT_TOKEN,
      policyAllowlisted: false,
      publicClient: {} as PublicClient,
    });
    const result = await createHireabilityAssessor(options)(
      agent([{ name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] }]),
      identity(),
    );
    expect(result).toMatchObject({ hireability: "invalid_quote", quoteStatus: "invalid" });
    expect(result.protocols[0]?.error?.message).toContain("policy is not allowlisted");
  });

  it("bounds seller endpoints per agent and reports skipped declarations", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      name: "seller",
      url: "https://fixture.example/a2a-one",
      skills: [],
    })) as unknown as typeof fetch;
    const result = await createHireabilityAssessor({
      ...assessorOptions(fetchImpl),
      maxEndpointsPerAgent: 1,
    })(agent([
      { name: "A2A", endpoint: "https://fixture.example/a2a-one", version: null, tools: [], capabilities: [] },
      { name: "A2A", endpoint: "https://fixture.example/a2a-two", version: null, tools: [], capabilities: [] },
      { name: "ERC-8183", endpoint: "https://fixture.example/erc8183", version: null, tools: [], capabilities: [] },
    ]), identity());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      hireability: "probe_incomplete",
      probe: { totalDeclaredEndpoints: 3, evaluatedEndpoints: 1, skippedEndpoints: 2, truncated: true },
    });
    expect(result.protocols.filter((protocol) => protocol.status === "not_probed")).toHaveLength(2);
  });

  it("stops probing when the run wall-clock budget is exhausted", async () => {
    const fetchImpl = vi.fn();
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(2);
    const result = await createHireabilityAssessor({
      ...assessorOptions(fetchImpl as unknown as typeof fetch),
      monotonicNow,
      maxTotalDurationMs: 1,
    })(agent([
      { name: "A2A", endpoint: "https://fixture.example/a2a", version: null, tools: [], capabilities: [] },
    ]), identity());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      hireability: "probe_incomplete",
      probe: { totalDeclaredEndpoints: 1, evaluatedEndpoints: 0, skippedEndpoints: 1, truncated: true },
    });
    expect(result.protocols[0]?.error?.code).toBe("SELLER_PROBE_BUDGET_EXHAUSTED");
  });

  it("shares the global endpoint budget across assessed agents", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const origin = new URL(input instanceof Request ? input.url : input.toString()).origin;
      return Response.json({ name: "seller", url: `${origin}/a2a`, skills: [] });
    }) as unknown as typeof fetch;
    const assess = createHireabilityAssessor({
      ...assessorOptions(fetchImpl),
      maxEndpointsPerRun: 1,
    });

    await assess(agent([
      { name: "A2A", endpoint: "https://one.example/a2a", version: null, tools: [], capabilities: [] },
    ]), identity());
    const second = await assess(agent([
      { name: "A2A", endpoint: "https://two.example/a2a", version: null, tools: [], capabilities: [] },
    ]), identity());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      hireability: "probe_incomplete",
      probe: { evaluatedEndpoints: 0, skippedEndpoints: 1, truncated: true },
    });
  });
});

function gate1Reader(overrides: Partial<Job> = {}): Gate1ProofReader {
  const job: Job = {
    id: 514n,
    client: "0x8bdC9Bc2a2de68715e181b72603Bb9A61eff7ddB",
    provider: "0xa0166a1c586f85Db39798ee311BAA7831C4Dc65b",
    evaluator: "0x5555555555555555555555555555555555555555",
    description: "sanitized",
    budget: 1n,
    expiredAt: 1_786_640_937n,
    status: JobStatus.SUBMITTED,
    hook: "0x6666666666666666666666666666666666666666",
    deliverable: "0x2ed47b2d41add5f9cef468b6748a1d52b3d6e753fac9c7e1de14766e6e315066",
    submittedAt: 1_786_636_559n,
    ...overrides,
  };
  return {
    assertChain: async () => undefined,
    getJob: async () => job,
    getPaymentToken: async () => "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    getAgentWallet: async () => "0xa0166a1c586f85Db39798ee311BAA7831C4Dc65b",
    getDeliverableUrl: async () => "https://fixture.example/deliverable/514",
    getTransaction: async (hash: Hash) => {
      const evidence = {
        "0x8767e5163c208d18ec4282d2a37c519b29fa03b6f6141e4f0458be8d64a243ce": ["124866822", "2026-08-13T15:54:03.000Z"],
        "0x843a8e9de35389942f04226c1b8322a0dc05ce3698aafea0fd8b2f13ad578f3f": ["124866829", "2026-08-13T15:54:06.000Z"],
        "0x1414750595ef9bc36f9b83c85f7345f9da74af4ad2b0a114152d94c1d7b62232": ["124866907", "2026-08-13T15:54:41.000Z"],
        "0x11bf5cd1de0a0a97547d39955c32eb4d890af2b38beb8dfaee5de21c71308885": ["124866912", "2026-08-13T15:54:43.000Z"],
        "0x7a3e76c1f11449264e89b7589e72d6c5acae804fba7142d26a6009edfa5ee227": ["124866923", "2026-08-13T15:54:48.000Z"],
        "0xe64f43b0a4daa7a60e2d0708d5851765be206da55563d601fa3c2dd2e5451a32": ["124867080", "2026-08-13T15:55:59.000Z"],
      } as const;
      const [blockNumber, timestamp] = evidence[hash as keyof typeof evidence];
      return { hash, status: "success", blockNumber, timestamp };
    },
  };
}

describe("Gate 1 proof", () => {
  it("verifies the public onchain evidence", async () => {
    const proof = await verifyGate1Proof(gate1Reader(), () => 1_776_643_200_000);
    expect(proof).toMatchObject({
      status: "verified",
      observedState: "SUBMITTED",
      jobId: "514",
      deadline: { unix: "1786640937", iso: "2026-08-13T17:08:57.000Z" },
      submittedAt: { unix: "1786636559", iso: "2026-08-13T15:55:59.000Z" },
    });
    expect(Object.keys(proof.transactions)).toHaveLength(6);
  });

  it("reports a mismatch instead of rewriting the expected proof", async () => {
    const proof = await verifyGate1Proof(gate1Reader({ budget: 2n }), () => 1_776_643_200_000);
    expect(proof.status).toBe("mismatch");
    expect(proof.checks.budgetMatches).toBe(false);
  });
});

function trustFixtureFetch(
  list: unknown,
  profiles: Record<string, unknown>,
  scores: Record<string, unknown>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v2/agents") return Response.json(list);
    if (url.pathname === "/api/v2/agents/profile") return Response.json(profiles[url.searchParams.get("agentId") ?? ""]);
    const match = url.pathname.match(/^\/api\/v2\/agents\/(\d+)\/score$/);
    return Response.json(scores[match?.[1] ?? ""]);
  }) as typeof fetch;
}

describe("marketplace readiness report", () => {
  it("allows frontend work while preserving partial activation coverage", async () => {
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
    const identityReader: BscIdentityReader = {
      registryAddress: onchain.registryAddress,
      assertChain: async () => undefined,
      getBlockNumber: async () => BigInt(onchain.blockNumber),
      readIdentity: async (agentId) => agentId === "45422"
        ? { ...onchain.agents[agentId]!, owner: "0x9999999999999999999999999999999999999999" }
        : onchain.agents[agentId]!,
    };
    const verifyMcp = async (endpoint: string, tools: string[]): Promise<McpEndpointVerification> => ({
      status: "protocol_valid",
      endpoint,
      protocol: "mcp",
      declaredTools: tools,
      observedTools: tools,
      comparison: { matched: tools, declaredOnly: [], observedOnly: [] },
      negotiatedProtocolVersion: "2025-06-18",
      serverInfo: { name: "sanitized-mcp", version: "1.0.0" },
      latencyMs: 1,
      observedAt: "2026-08-17T00:00:00.000Z",
      provenance: "observed:mcp-tools-list",
      error: null,
    });
    const mcpOnly: HireabilityAssessment = {
      transport: "mcp_only",
      declaredSellerProtocols: [],
      quoteStatus: "not_applicable",
      hireability: "mcp_only",
      protocols: [],
      probe: { totalDeclaredEndpoints: 0, evaluatedEndpoints: 0, skippedEndpoints: 0, truncated: false },
      note: "MCP is not ERC-8183 hireability.",
      provenance: "derived:marketplace-readiness",
    };
    const report = await buildBscMarketplaceReadinessReport({
      provider: new Trust8004Provider({
        fetch: trustFixtureFetch(list, profiles, scores),
        minimumRequestIntervalMs: 0,
      }),
      identityReader,
      gate1Reader: gate1Reader(),
      verifyMcp,
      assessHireability: async (candidate) => candidate.agentId === "45422"
        ? quoteVerifiedAssessment(onchain.agents["45422"]!.agentWallet)
        : mcpOnly,
      now: () => 1_776_643_200_000,
    });
    expect(report).toMatchObject({
      schemaVersion: 2,
      frontendReady: true,
      selection: { curatedAgentIds: KNOWN_HEYANON_AGENT_IDS, explicitAgentIds: [] },
      activationCoverage: {
        status: "partial",
        quoteVerifiedAgents: 1,
        qualifiedSellerAgentIds: [],
        quoteVerifiedCategories: 1,
      },
      sellerQualification: { status: "attention_required", qualifiedAgentIds: [] },
      buyerProof: { status: "verified" },
      catalog: { source: "trust8004", coverage: "partial" },
    });
    expect(report.candidates).toHaveLength(4);
    expect(report.categories.yield_optimisation).toMatchObject({
      quoteVerifiedAgentIds: ["45422"],
      qualifiedAgentIds: [],
    });
    expect(report.categories.grid_trading).toMatchObject({
      status: "unverified",
      quoteVerifiedAgentIds: [],
      qualifiedAgentIds: [],
    });
    expect(readinessExitCode(report)).toBe(0);

    const directory = await mkdtemp(join(tmpdir(), "bsc-readiness-"));
    try {
      const destination = join(directory, "report.json");
      await Promise.all([
        writeReadinessReport(destination, report),
        writeReadinessReport(destination, report),
      ]);
      expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({ frontendReady: true });
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["report.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("qualifies an explicit seller without promoting it into curated categories", async () => {
    const [list, sourceProfiles, sourceScores, onchain] = await Promise.all([
      fixture("trust8004/list.json"),
      fixture("trust8004/profiles.json") as Promise<Record<string, unknown>>,
      fixture("trust8004/scores.json") as Promise<Record<string, unknown>>,
      fixture("verification/onchain.json") as Promise<{
        registryAddress: Address;
        blockNumber: string;
        agents: Record<string, { owner: Address; agentWallet: Address; metadataUri: string }>;
      }>,
    ]);
    const profiles = structuredClone(sourceProfiles);
    const scores = structuredClone(sourceScores);
    profiles["999"] = structuredClone(profiles["45650"]);
    scores["999"] = structuredClone(scores["45650"]);
    (profiles["999"] as { agent: { agentId: string; name: string } }).agent.agentId = "999";
    (profiles["999"] as { agent: { agentId: string; name: string } }).agent.name = "Explicit seller candidate";
    (scores["999"] as { agentId: string }).agentId = "999";
    const explicitIdentity = onchain.agents["45650"]!;
    const qualified = quoteVerifiedAssessment(explicitIdentity.agentWallet);
    const mcpOnly: HireabilityAssessment = {
      transport: "mcp_only",
      declaredSellerProtocols: [],
      quoteStatus: "not_applicable",
      hireability: "mcp_only",
      protocols: [],
      probe: { totalDeclaredEndpoints: 0, evaluatedEndpoints: 0, skippedEndpoints: 0, truncated: false },
      note: "MCP is not ERC-8183 hireability.",
      provenance: "derived:marketplace-readiness",
    };
    const report = await buildBscMarketplaceReadinessReport({
      provider: new Trust8004Provider({
        fetch: trustFixtureFetch(list, profiles, scores),
        minimumRequestIntervalMs: 0,
      }),
      identityReader: {
        registryAddress: onchain.registryAddress,
        assertChain: async () => undefined,
        getBlockNumber: async () => BigInt(onchain.blockNumber),
        readIdentity: async (agentId) => agentId === "999" ? explicitIdentity : onchain.agents[agentId]!,
      },
      gate1Reader: gate1Reader(),
      verifyMcp: async (endpoint, declaredTools) => ({
        status: "protocol_valid",
        endpoint,
        protocol: "mcp",
        declaredTools,
        observedTools: declaredTools,
        comparison: { matched: declaredTools, declaredOnly: [], observedOnly: [] },
        negotiatedProtocolVersion: "2025-06-18",
        serverInfo: { name: "sanitized-mcp", version: "1.0.0" },
        latencyMs: 1,
        observedAt: "2031-10-17T10:40:00.000Z",
        provenance: "observed:mcp-tools-list",
        error: null,
      }),
      assessHireability: async (candidate) => candidate.agentId === "999" ? qualified : mcpOnly,
      additionalAgentIds: ["999", "45650"],
      now: () => 1_950_000_000_000,
    });

    expect(report.selection.explicitAgentIds).toEqual(["999"]);
    expect(report.sellerQualification).toMatchObject({ status: "passed", qualifiedAgentIds: ["999"] });
    expect(report.activationCoverage).toMatchObject({
      qualifiedSellerAgentIds: ["999"],
      qualifiedCuratedAgentIds: [],
      quoteVerifiedCategories: 0,
    });
    expect(report.candidates.find((candidate) => candidate.agentId === "999")).toMatchObject({
      selection: "operator_explicit",
      categories: [],
      curatedCategories: [],
      qualification: { status: "qualified", reasons: [] },
    });
    expect(Object.values(report.categories).every((category) => !category.agentIds.includes("999"))).toBe(true);
  });

  it("validates CLI output arguments", () => {
    expect(parseOutputPath([])).toMatch(/\.marketplace\/readiness\/bsc-marketplace\.json$/);
    expect(parseOutputPath(["--output", "custom.json"])).toMatch(/custom\.json$/);
    expect(() => parseOutputPath(["--unknown"])).toThrow("Unknown argument");
    expect(() => parseOutputPath(["--output"])).toThrow("requires a value");
    expect(parseReadinessArgs(["--agent-id", "0045650", "--agent-id", "45650"]).additionalAgentIds).toEqual(["45650"]);
    expect(() => parseReadinessArgs(["--agent-id", "not-numeric"])).toThrow("must be numeric");
    expect(() => parseReadinessArgs(["--agent-id", (1n << 256n).toString()])).toThrow("exceeds uint256");
    expect(readinessFatalMessage(new Trust8004HttpError(502, "https://secret.invalid", "Bearer secret")))
      .toBe("TRUST8004_HTTP_502: the public catalogue request failed.");
    expect(readinessFatalMessage(new DOMException("sensitive timeout", "TimeoutError")))
      .toBe("TRUST8004_UNAVAILABLE: the public catalogue request timed out.");
    expect(readinessFatalMessage(new Error("--agent-id must be numeric: invalid")))
      .toBe("INVALID_ARGUMENT: --agent-id must be numeric: invalid");
    expect(readinessFatalMessage(new Error("--agent-id exceeds uint256: invalid")))
      .toBe("INVALID_ARGUMENT: --agent-id exceeds uint256: invalid");
  });
});

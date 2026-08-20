import {
  ERC8183Client,
  NegotiationHandler,
  NegotiationRequest,
  TermSpecification,
  verifyQuoteSignature,
} from "@bnbagent/sdk/erc8183";
import { resolveNetwork } from "@bnbagent/sdk";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { fetchAgentCard, sendSkill } from "../a2a.js";
import type { MarketplaceAgent } from "../trust8004/types.js";
import { readBoundedJson } from "../verification/bounded-json.js";
import {
  createSafeEndpointTransport,
  type ResolveHostname,
  type SafeEndpointTransport,
} from "../verification/safe-http.js";
import type { IdentityVerification, VerificationError } from "../verification/types.js";
import type {
  HireabilityAssessment,
  QuoteEvidence,
  SellerProtocolVerification,
  SellerTransport,
} from "./types.js";

interface QuoteContext {
  chainId: 56;
  commerce: Address;
  router: Address;
  policy: Address;
  paymentToken: Address;
  policyAllowlisted: boolean;
  publicClient: PublicClient;
}

type QuoteVerdict =
  | { valid: true; method: "eip191" | "erc1271"; signer: Address }
  | { valid: false; reason: string };

export interface HireabilityAssessorOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  timeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  maxEndpointsPerAgent?: number;
  maxEndpointsPerRun?: number;
  maxTotalDurationMs?: number;
  createQuoteContext?: () => Promise<QuoteContext>;
  verifyQuote?: (options: {
    envelope: Record<string, unknown>;
    provider: Address;
    publicClient: PublicClient;
    expectedVerifyingContract: Address;
  }) => Promise<QuoteVerdict>;
}

const QUOTE_TERMS = new TermSpecification({
  deliverables: "Return a deterministic text readiness receipt",
  qualityStandards: "Provide a signed ERC-8183 quote without executing work",
});
const QUOTE_NEGOTIATION_REQUEST = new NegotiationRequest({
  taskDescription: "Marketplace readiness quote probe; no job will be funded",
  terms: QUOTE_TERMS,
});
const QUOTE_REQUEST = QUOTE_NEGOTIATION_REQUEST.toDict();
const QUOTE_REQUEST_HASH = QUOTE_NEGOTIATION_REQUEST.computeHash().toLowerCase();

const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_QUOTE_CLOCK_SKEW_SECONDS = 60;
const MAX_QUOTE_AGE_SECONDS = 60;
const DEFAULT_MAX_ENDPOINTS_PER_AGENT = 2;
const DEFAULT_MAX_ENDPOINTS_PER_RUN = 48;
const DEFAULT_MAX_TOTAL_DURATION_MS = 180_000;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function sanitizedError(error: unknown, code: string): VerificationError {
  const candidate = error instanceof Error ? error.message : "";
  const safeValidationMessage = /^(Agent Card|A2A|Endpoint returned HTTP \d{3}$|Endpoint returned invalid JSON$|Endpoint response exceeded|ERC-8183|Quote |Configured BSC Mainnet policy)/.test(candidate)
    ? candidate.slice(0, 300)
    : null;
  return {
    code,
    message: safeValidationMessage ?? (code === "SELLER_UNREACHABLE"
      ? "The declared seller endpoint could not be reached."
      : code === "SELLER_UNSAFE_URL"
        ? "The declared seller endpoint is not safe to probe."
        : "The seller protocol response failed validation."),
  };
}

function declaredProtocols(agent: MarketplaceAgent): Array<{
  transport: SellerTransport;
  endpoint: string;
}> {
  const protocols = new Map<string, { transport: SellerTransport; endpoint: string }>();
  for (const service of agent.services) {
    if (!service.endpoint) continue;
    const normalized = service.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const transport = normalized === "a2a"
      ? "a2a"
      : normalized === "erc8183"
        ? "erc8183_http"
        : null;
    if (transport) protocols.set(`${transport}:${service.endpoint}`, { transport, endpoint: service.endpoint });
  }
  return [...protocols.values()];
}

function hasMcp(agent: MarketplaceAgent): boolean {
  return agent.services.some((service) => service.name.toLowerCase() === "mcp" && service.endpoint);
}

async function fetchJsonObject(
  url: URL,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status}`);
  const value = await readBoundedJson(response, {
    maxBytes: MAX_HTTP_RESPONSE_BYTES,
    tooLargeMessage: "Endpoint response exceeded the allowed size",
    invalidJsonMessage: "Endpoint returned invalid JSON",
  });
  return record(value, "response");
}

function httpUrls(endpoint: string): { health: URL; status: URL; negotiate: URL } {
  const declared = new URL(endpoint);
  declared.search = "";
  declared.hash = "";
  const path = declared.pathname.replace(/\/+$/, "");
  const suffix = path.match(/\/(health|status|negotiate)$/)?.[1];
  const base = suffix ? path.slice(0, -(suffix.length + 1)) : path;
  const url = (route: string) => {
    const result = new URL(declared);
    result.pathname = `${base}/${route}`.replace(/\/{2,}/g, "/");
    return result;
  };
  return { health: url("health"), status: url("status"), negotiate: url("negotiate") };
}

function validateHttpHealth(value: Record<string, unknown>): void {
  if (value.status !== "ok" || value.service !== "ERC-8183 Agent") {
    throw new Error("ERC-8183 health response has an invalid shape");
  }
}

function validateHttpStatus(
  value: Record<string, unknown>,
  expectedProvider: Address | null,
  context: QuoteContext | null,
): void {
  const addressFields = ["agent_address", "commerce_address", "router_address", "policy_address"] as const;
  if (value.status !== "ok") throw new Error("ERC-8183 status response is not ok");
  for (const field of addressFields) {
    if (typeof value[field] !== "string" || !isAddress(value[field])) {
      throw new Error(`ERC-8183 status ${field} is invalid`);
    }
  }
  if (typeof value.service_price !== "string" || !/^\d+$/.test(value.service_price)) {
    throw new Error("ERC-8183 status service_price is invalid");
  }
  if (typeof value.currency !== "string" || (value.currency !== "" && !isAddress(value.currency))) {
    throw new Error("ERC-8183 status currency is invalid");
  }
  if (!Number.isInteger(value.decimals) || Number(value.decimals) < 0) {
    throw new Error("ERC-8183 status decimals is invalid");
  }
  if (expectedProvider && getAddress(String(value.agent_address)) !== expectedProvider) {
    throw new Error("ERC-8183 status agent_address does not match the ERC-8004 agent wallet");
  }
  if (context) {
    if (getAddress(String(value.commerce_address)) !== context.commerce) {
      throw new Error("ERC-8183 status commerce_address does not match Commerce");
    }
    if (!value.currency || getAddress(String(value.currency)) !== context.paymentToken) {
      throw new Error("ERC-8183 status currency does not match Commerce payment token");
    }
    if (getAddress(String(value.router_address)) !== context.router) {
      throw new Error("ERC-8183 status router_address does not match Router");
    }
    if (getAddress(String(value.policy_address)) !== context.policy || !context.policyAllowlisted) {
      throw new Error("ERC-8183 status policy is not the allowlisted policy");
    }
  }
}

function quoteTimestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer timestamp`);
  }
  return value;
}

async function validateQuote(
  value: Record<string, unknown>,
  expectedProvider: Address,
  context: QuoteContext,
  verifyQuote: NonNullable<HireabilityAssessorOptions["verifyQuote"]>,
  observedAt: string,
  nowSeconds: number,
): Promise<QuoteEvidence> {
  if (!context.policyAllowlisted) throw new Error("Configured BSC Mainnet policy is not allowlisted");
  const request = record(value.request, "request");
  if (typeof value.request_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.request_hash)) {
    throw new Error("Quote request_hash is invalid");
  }
  const embeddedRequestHash = NegotiationRequest.fromDict(request).computeHash().toLowerCase();
  if (embeddedRequestHash !== QUOTE_REQUEST_HASH || value.request_hash.toLowerCase() !== QUOTE_REQUEST_HASH) {
    throw new Error("Quote request does not match the readiness probe");
  }
  const response = record(value.response, "response");
  const terms = record(response.terms, "response.terms");
  if (response.accepted !== true) throw new Error("Quote was not accepted");
  if (
    terms.deliverables !== QUOTE_TERMS.deliverables
    || terms.quality_standards !== QUOTE_TERMS.qualityStandards
  ) {
    throw new Error("Quote terms do not match the readiness probe");
  }
  if (typeof terms.price !== "string" || !/^\d+$/.test(terms.price) || BigInt(terms.price) <= 0n) {
    throw new Error("Quote price must be a positive raw-unit integer");
  }
  if (typeof terms.currency !== "string" || !isAddress(terms.currency)) {
    throw new Error("Quote currency is invalid");
  }
  const currency = getAddress(terms.currency);
  if (currency !== context.paymentToken) throw new Error("Quote currency does not match Commerce payment token");
  if (value.chain_id !== context.chainId) throw new Error("Quote chain_id does not match BSC Mainnet");
  if (typeof value.verifying_contract !== "string" || !isAddress(value.verifying_contract)) {
    throw new Error("Quote verifying_contract is invalid");
  }
  if (getAddress(value.verifying_contract) !== context.commerce) {
    throw new Error("Quote verifying_contract does not match Commerce");
  }
  if (typeof value.negotiation_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.negotiation_hash)) {
    throw new Error("Quote negotiation_hash is invalid");
  }
  if (typeof value.provider_sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(value.provider_sig)) {
    throw new Error("Quote provider_sig is invalid");
  }
  if (value.provider_address !== undefined) {
    if (typeof value.provider_address !== "string" || !isAddress(value.provider_address)) {
      throw new Error("Quote provider_address is invalid");
    }
    if (getAddress(value.provider_address) !== expectedProvider) {
      throw new Error("Quote provider_address does not match the ERC-8004 agent wallet");
    }
  }
  const negotiatedAt = quoteTimestamp(
    value.negotiated_at ?? response.negotiated_at,
    "quote negotiated_at",
  );
  const quoteExpiresAt = quoteTimestamp(
    value.quote_expires_at ?? response.quote_expires_at,
    "quote quote_expires_at",
  );
  if (negotiatedAt > nowSeconds + MAX_QUOTE_CLOCK_SKEW_SECONDS) {
    throw new Error("Quote negotiated_at is in the future");
  }
  if (nowSeconds - negotiatedAt > MAX_QUOTE_AGE_SECONDS) {
    throw new Error("Quote negotiated_at is stale");
  }
  if (quoteExpiresAt <= nowSeconds || quoteExpiresAt <= negotiatedAt) {
    throw new Error("Quote is expired or has an invalid validity window");
  }
  if (quoteExpiresAt - negotiatedAt > NegotiationHandler.MAX_QUOTE_TTL_SECONDS) {
    throw new Error("Quote validity window exceeds the SDK maximum");
  }
  const verdict = await verifyQuote({
    envelope: value,
    provider: expectedProvider,
    publicClient: context.publicClient,
    expectedVerifyingContract: context.commerce,
  });
  if (!verdict.valid) throw new Error("Quote signature rejected.");
  return {
    provider: expectedProvider,
    price: terms.price,
    currency,
    verifyingContract: context.commerce,
    contractContext: {
      chainId: context.chainId,
      commerce: context.commerce,
      router: context.router,
      policy: context.policy,
      paymentToken: context.paymentToken,
      policyAllowlisted: true,
      provenance: "configured:bnbagent-sdk+onchain:bsc-mainnet-rpc",
    },
    negotiationHash: value.negotiation_hash as `0x${string}`,
    signatureMethod: verdict.method,
    negotiatedAt,
    quoteExpiresAt,
    observedAt,
    provenance: "observed:erc8183-signed-quote",
  };
}

function result(
  transport: SellerTransport,
  endpoint: string,
  observedAt: string,
  overrides: Partial<SellerProtocolVerification>,
): SellerProtocolVerification {
  return {
    transport,
    endpoint,
    status: "unreachable",
    quoteStatus: "unavailable",
    agentCardSkills: null,
    healthObserved: null,
    statusObserved: null,
    quote: null,
    observedAt,
    provenance: "declared:trust8004-public-api+observed:marketplace-probe",
    error: null,
    ...overrides,
  };
}

function classifyFailure(error: unknown): {
  status: SellerProtocolVerification["status"];
  quoteStatus: SellerProtocolVerification["quoteStatus"];
  code: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP|timeout|fetch failed|network/i.test(message)) {
    return { status: "unreachable", quoteStatus: "unavailable", code: "SELLER_UNREACHABLE" };
  }
  return { status: "invalid_response", quoteStatus: "invalid", code: "SELLER_INVALID_RESPONSE" };
}

async function assessProtocol(
  protocol: { transport: SellerTransport; endpoint: string },
  expectedProvider: Address | null,
  getContext: () => Promise<QuoteContext>,
  options: HireabilityAssessorOptions,
): Promise<SellerProtocolVerification> {
  const now = options.now ?? Date.now;
  const observedAtMs = now();
  const observedAt = new Date(observedAtMs).toISOString();
  const nowSeconds = Math.floor(observedAtMs / 1_000);
  let safeTransport: SafeEndpointTransport;
  try {
    safeTransport = await createSafeEndpointTransport(protocol.endpoint, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  } catch (error) {
    return result(protocol.transport, protocol.endpoint, observedAt, {
      status: "unsafe_url",
      quoteStatus: "not_requested",
      error: sanitizedError(error, "SELLER_UNSAFE_URL"),
    });
  }
  const fetchImpl = safeTransport.fetch;
  const verifyQuote = options.verifyQuote ?? verifyQuoteSignature;

  try {
    if (protocol.transport === "a2a") {
      const card = await fetchAgentCard(protocol.endpoint, null, fetchImpl);
      const skills = [...new Set(card.skills.map((skill) => skill.id))].sort();
      const missing = ["negotiate-erc8183-job", "notify_funded"].filter((skill) => !skills.includes(skill));
      if (missing.length > 0) {
        return result(protocol.transport, protocol.endpoint, observedAt, {
          status: "protocol_valid",
          quoteStatus: "not_requested",
          agentCardSkills: skills,
          error: { code: "A2A_REQUIRED_SKILLS_MISSING", message: `Agent Card is missing: ${missing.join(", ")}` },
        });
      }
      if (!expectedProvider) {
        return result(protocol.transport, protocol.endpoint, observedAt, {
          status: "protocol_valid",
          quoteStatus: "not_requested",
          agentCardSkills: skills,
          error: { code: "ONCHAIN_PROVIDER_UNAVAILABLE", message: "ERC-8004 agent wallet could not be read onchain." },
        });
      }
      const quote = await sendSkill(
        card.url,
        { skill: "negotiate-erc8183-job", ...QUOTE_REQUEST },
        null,
        fetchImpl,
      );
      const evidence = await validateQuote(
        quote,
        expectedProvider,
        await getContext(),
        verifyQuote,
        observedAt,
        nowSeconds,
      );
      return result(protocol.transport, protocol.endpoint, observedAt, {
        status: "quote_verified",
        quoteStatus: "verified",
        agentCardSkills: skills,
        quote: evidence,
      });
    }

    const urls = httpUrls(protocol.endpoint);
    const health = await fetchJsonObject(urls.health, fetchImpl, { headers: { accept: "application/json" } });
    const status = await fetchJsonObject(urls.status, fetchImpl, { headers: { accept: "application/json" } });
    validateHttpHealth(health);
    if (!expectedProvider) {
      validateHttpStatus(status, null, null);
      return result(protocol.transport, protocol.endpoint, observedAt, {
        status: "protocol_valid",
        quoteStatus: "not_requested",
        healthObserved: true,
        statusObserved: true,
        error: { code: "ONCHAIN_PROVIDER_UNAVAILABLE", message: "ERC-8004 agent wallet could not be read onchain." },
      });
    }
    const context = await getContext();
    validateHttpStatus(status, expectedProvider, context);
    const quote = await fetchJsonObject(urls.negotiate, fetchImpl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(QUOTE_REQUEST),
    });
    const evidence = await validateQuote(
      quote,
      expectedProvider,
      context,
      verifyQuote,
      observedAt,
      nowSeconds,
    );
    return result(protocol.transport, protocol.endpoint, observedAt, {
      status: "quote_verified",
      quoteStatus: "verified",
      healthObserved: true,
      statusObserved: true,
      quote: evidence,
    });
  } catch (error) {
    const failure = classifyFailure(error);
    return result(protocol.transport, protocol.endpoint, observedAt, {
      status: failure.status,
      quoteStatus: failure.quoteStatus,
      error: sanitizedError(error, failure.code),
    });
  } finally {
    await safeTransport.close().catch(() => undefined);
  }
}

async function defaultQuoteContext(): Promise<QuoteContext> {
  const network = resolveNetwork("bsc-mainnet");
  const client = await ERC8183Client.create({ network });
  const policy = getAddress(network.policyContract);
  const policyAllowlisted = await client.router.policyWhitelist(policy);
  if (!policyAllowlisted) throw new Error("Configured BSC Mainnet policy is not allowlisted");
  return {
    chainId: 56,
    commerce: getAddress(network.commerceContract),
    router: getAddress(network.routerContract),
    policy,
    paymentToken: getAddress(await client.paymentToken()),
    policyAllowlisted,
    publicClient: client.publicClient,
  };
}

function summarize(
  protocols: Array<{ transport: SellerTransport; endpoint: string }>,
  observations: SellerProtocolVerification[],
  mcp: boolean,
): HireabilityAssessment {
  const skippedEndpoints = observations.filter((observation) => observation.status === "not_probed").length;
  const probe = {
    totalDeclaredEndpoints: protocols.length,
    evaluatedEndpoints: observations.length - skippedEndpoints,
    skippedEndpoints,
    truncated: skippedEndpoints > 0,
  };
  if (protocols.length === 0) {
    return {
      transport: mcp ? "mcp_only" : "none",
      declaredSellerProtocols: [],
      quoteStatus: "not_applicable",
      hireability: mcp ? "mcp_only" : "not_declared",
      protocols: [],
      probe,
      note: mcp
        ? "MCP is declared, but MCP availability is not ERC-8183 hireability."
        : "No declared A2A or HTTP ERC-8183 service was found.",
      provenance: "derived:marketplace-readiness",
    };
  }
  const transports = [...new Set(protocols.map((protocol) => protocol.transport))];
  const verified = observations.some((observation) => observation.quoteStatus === "verified");
  const protocolValid = observations.some((observation) => observation.status === "protocol_valid");
  const unreachable = observations.every((observation) =>
    observation.status === "unreachable" || observation.status === "unsafe_url");
  return {
    transport: transports.length > 1 ? "multiple" : transports[0]!,
    declaredSellerProtocols: transports,
    quoteStatus: verified
      ? "verified"
      : probe.truncated
        ? "unavailable"
        : protocolValid
          ? "not_requested"
          : unreachable
            ? "unavailable"
            : "invalid",
    hireability: verified
      ? "quote_verified"
      : probe.truncated
        ? "probe_incomplete"
        : protocolValid
          ? "protocol_discovered"
          : unreachable
            ? "unreachable"
            : "invalid_quote",
    protocols: observations,
    probe,
    note: verified
      ? "A signed quote was verified; delivery and job execution are not proven."
      : probe.truncated
        ? "Seller protocol probing was truncated before every declared endpoint could be evaluated."
        : "No verifiable signed ERC-8183 quote is currently available.",
    provenance: "derived:marketplace-readiness",
  };
}

export function createHireabilityAssessor(
  options: HireabilityAssessorOptions = {},
): (agent: MarketplaceAgent, identity: IdentityVerification) => Promise<HireabilityAssessment> {
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  const maxEndpointsPerAgent = options.maxEndpointsPerAgent ?? DEFAULT_MAX_ENDPOINTS_PER_AGENT;
  const maxEndpointsPerRun = options.maxEndpointsPerRun ?? DEFAULT_MAX_ENDPOINTS_PER_RUN;
  const maxTotalDurationMs = options.maxTotalDurationMs ?? DEFAULT_MAX_TOTAL_DURATION_MS;
  let evaluatedEndpoints = 0;
  let context: Promise<QuoteContext> | null = null;
  const getContext = () => {
    context ??= (options.createQuoteContext ?? defaultQuoteContext)();
    return context;
  };
  return async (agent, identity) => {
    const protocols = declaredProtocols(agent);
    if (protocols.length === 0) return summarize(protocols, [], hasMcp(agent));
    const provider = identity.onchain.agentWallet;
    const observations: SellerProtocolVerification[] = [];
    const selectedTransports = new Set<SellerTransport>();
    const selected = new Set(protocols.filter((protocol) => {
      if (selectedTransports.has(protocol.transport) || selectedTransports.size >= maxEndpointsPerAgent) {
        return false;
      }
      selectedTransports.add(protocol.transport);
      return true;
    }));
    for (const protocol of protocols) {
      const observedAt = new Date((options.now ?? Date.now)()).toISOString();
      if (!selected.has(protocol)) {
        observations.push(result(protocol.transport, protocol.endpoint, observedAt, {
          status: "not_probed",
          quoteStatus: "not_requested",
          error: {
            code: "SELLER_ENDPOINT_LIMIT_REACHED",
            message: "The endpoint was not probed because the per-agent limit was reached.",
          },
        }));
        continue;
      }
      const remainingMs = maxTotalDurationMs - (monotonicNow() - startedAt);
      if (evaluatedEndpoints >= maxEndpointsPerRun || remainingMs <= 0) {
        observations.push(result(protocol.transport, protocol.endpoint, observedAt, {
          status: "not_probed",
          quoteStatus: "not_requested",
          error: {
            code: "SELLER_PROBE_BUDGET_EXHAUSTED",
            message: "The endpoint was not probed because the execution budget was exhausted.",
          },
        }));
        continue;
      }
      evaluatedEndpoints += 1;
      observations.push(await assessProtocol(protocol, provider, getContext, {
        ...options,
        timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 10_000, remainingMs)),
      }));
    }
    return summarize(protocols, observations, hasMcp(agent));
  };
}

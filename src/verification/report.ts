import { getAddress, isAddress } from "viem";
import { buildBscCandidateInventory } from "../trust8004/inventory.js";
import type { Trust8004Provider } from "../trust8004/provider.js";
import type { BscCandidateInventory, MarketplaceAgent, MarketplaceCategory } from "../trust8004/types.js";
import type { BscIdentityReader } from "./onchain.js";
import { verifyMcpEndpoint, type McpVerifierOptions } from "./mcp.js";
import type {
  AgentVerification,
  BscVerificationReport,
  IdentityVerification,
  McpEndpointVerification,
  VerificationError,
} from "./types.js";

export interface BuildVerificationReportOptions {
  provider: Trust8004Provider;
  identityReader: BscIdentityReader;
  inventory?: BscCandidateInventory;
  verifyMcp?: typeof verifyMcpEndpoint;
  mcpOptions?: McpVerifierOptions;
  now?: () => number;
}

function curatedCategories(
  inventory: BscCandidateInventory,
  agentId: string,
): MarketplaceCategory[] {
  return (Object.keys(inventory.categories) as MarketplaceCategory[])
    .filter((category) => inventory.categories[category].agentIds.includes(agentId));
}

function sanitizedError(error: unknown, code: string): VerificationError {
  const candidate = error && typeof error === "object" && "shortMessage" in error
    ? String((error as { shortMessage: unknown }).shortMessage)
    : error instanceof Error
      ? error.message
      : String(error);
  const message = candidate
    .replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]")
    .replace(/(bearer|token|password|secret)=?\s*[^\s]+/gi, "$1=[redacted]")
    .slice(0, 300);
  return { code, message: message || "Verification failed." };
}

function ownerMatches(declared: string, onchain: string): boolean {
  return isAddress(declared) && getAddress(declared) === getAddress(onchain);
}

async function verifyIdentity(
  agent: MarketplaceAgent,
  identityReader: BscIdentityReader,
  blockNumber: bigint,
  observedAt: string,
): Promise<IdentityVerification> {
  try {
    const onchain = await identityReader.readIdentity(agent.agentId, blockNumber);
    const checks = {
      ownerMatches: ownerMatches(agent.owner, onchain.owner),
      metadataUriMatches: agent.metadataUri === onchain.metadataUri,
    };
    return {
      status: checks.ownerMatches && checks.metadataUriMatches ? "match" : "mismatch",
      declared: {
        owner: agent.owner,
        metadataUri: agent.metadataUri,
        provenance: "declared:trust8004-public-api",
      },
      onchain: {
        owner: onchain.owner,
        agentWallet: onchain.agentWallet,
        metadataUri: onchain.metadataUri,
        registryAddress: identityReader.registryAddress,
        blockNumber: blockNumber.toString(),
        provenance: "onchain:bsc-rpc",
      },
      checks,
      observedAt,
      error: null,
    };
  } catch (error) {
    return {
      status: "read_error",
      declared: {
        owner: agent.owner,
        metadataUri: agent.metadataUri,
        provenance: "declared:trust8004-public-api",
      },
      onchain: {
        owner: null,
        agentWallet: null,
        metadataUri: null,
        registryAddress: identityReader.registryAddress,
        blockNumber: blockNumber.toString(),
        provenance: "onchain:bsc-rpc",
      },
      checks: { ownerMatches: null, metadataUriMatches: null },
      observedAt,
      error: sanitizedError(error, "ONCHAIN_IDENTITY_READ_FAILED"),
    };
  }
}

function mcpTargets(agent: MarketplaceAgent): Array<{ endpoint: string; tools: string[] }> {
  const targets = new Map<string, Set<string>>();
  for (const service of agent.services) {
    if (service.name.toLowerCase() !== "mcp" || !service.endpoint) continue;
    const tools = targets.get(service.endpoint) ?? new Set<string>();
    for (const tool of service.tools) tools.add(tool);
    targets.set(service.endpoint, tools);
  }
  return [...targets].map(([endpoint, tools]) => ({ endpoint, tools: [...tools] }));
}

function hasToolDrift(endpoint: McpEndpointVerification): boolean {
  return endpoint.comparison.declaredOnly.length > 0 || endpoint.comparison.observedOnly.length > 0;
}

export async function buildBscVerificationReport(
  options: BuildVerificationReportOptions,
): Promise<BscVerificationReport> {
  const now = options.now ?? Date.now;
  const verifyMcp = options.verifyMcp ?? verifyMcpEndpoint;
  const inventory = options.inventory ?? await buildBscCandidateInventory(options.provider, now);
  await options.identityReader.assertChain();
  const blockNumber = await options.identityReader.getBlockNumber();
  const generatedAt = new Date(now()).toISOString();
  const agents: AgentVerification[] = [];

  for (const agent of inventory.agents) {
    const identity = await verifyIdentity(agent, options.identityReader, blockNumber, generatedAt);
    const mcpEndpoints: McpEndpointVerification[] = [];
    for (const target of mcpTargets(agent)) {
      mcpEndpoints.push(await verifyMcp(target.endpoint, target.tools, options.mcpOptions));
    }
    agents.push({
      agentId: agent.agentId,
      name: agent.name,
      categories: curatedCategories(inventory, agent.agentId),
      identity,
      mcpEndpoints,
      hireability: "not_assessed",
    });
  }

  const endpoints = agents.flatMap((agent) => agent.mcpEndpoints);
  const identityMatches = agents.filter((agent) => agent.identity.status === "match").length;
  const endpointsValid = endpoints.filter((endpoint) => endpoint.status === "protocol_valid").length;
  const agentsWithoutMcpEndpoint = agents.filter((agent) => agent.mcpEndpoints.length === 0).length;
  const toolDriftEndpoints = endpoints.filter(hasToolDrift).length;
  const identityAttention = agents.length - identityMatches;
  const endpointAttention = endpoints.length - endpointsValid;
  const attentionRequired = identityAttention > 0
    || endpointAttention > 0
    || agentsWithoutMcpEndpoint > 0
    || toolDriftEndpoints > 0;

  return {
    schemaVersion: 1,
    generatedAt,
    chainId: 56,
    catalog: {
      source: "trust8004",
      coverage: "partial",
      snapshotGeneratedAt: inventory.generatedAt,
    },
    onchain: {
      network: "bsc-mainnet",
      registryAddress: options.identityReader.registryAddress,
      blockNumber: blockNumber.toString(),
    },
    categories: inventory.categories,
    summary: {
      status: attentionRequired ? "attention_required" : "complete",
      agentsTotal: agents.length,
      identityMatches,
      identityAttention,
      endpointsTotal: endpoints.length,
      endpointsValid,
      endpointAttention,
      agentsWithoutMcpEndpoint,
      toolDriftEndpoints,
    },
    agents,
  };
}

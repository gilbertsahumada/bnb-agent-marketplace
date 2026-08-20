import { KNOWN_HEYANON_AGENT_IDS, buildBscCandidateInventory } from "../trust8004/inventory.js";
import type { Trust8004Provider } from "../trust8004/provider.js";
import type { MarketplaceAgent, MarketplaceCategory } from "../trust8004/types.js";
import { verifyMcpEndpoint, type McpVerifierOptions } from "../verification/mcp.js";
import type { BscIdentityReader } from "../verification/onchain.js";
import { buildBscVerificationReport } from "../verification/report.js";
import type { IdentityVerification } from "../verification/types.js";
import type { Gate1ProofReader } from "./gate1.js";
import { verifyGate1Proof } from "./gate1.js";
import { createHireabilityAssessor } from "./protocols.js";
import type {
  BscMarketplaceReadinessReport,
  HireabilityAssessment,
  ReadinessCandidate,
} from "./types.js";

export interface BuildReadinessReportOptions {
  provider: Trust8004Provider;
  identityReader: BscIdentityReader;
  gate1Reader: Gate1ProofReader;
  verifyMcp?: typeof verifyMcpEndpoint;
  mcpOptions?: McpVerifierOptions;
  assessHireability?: (
    agent: MarketplaceAgent,
    identity: IdentityVerification,
  ) => Promise<HireabilityAssessment>;
  additionalAgentIds?: readonly string[];
  now?: () => number;
}

function curatedCategories(
  inventory: Awaited<ReturnType<typeof buildBscCandidateInventory>>,
  agentId: string,
) {
  return (Object.keys(inventory.categories) as MarketplaceCategory[])
    .filter((category) => inventory.categories[category].agentIds.includes(agentId));
}

function qualification(
  activation: HireabilityAssessment,
  identity: IdentityVerification,
): ReadinessCandidate["qualification"] {
  const reasons: ReadinessCandidate["qualification"]["reasons"] = [];
  if (identity.status === "read_error") reasons.push("IDENTITY_UNAVAILABLE");
  else if (identity.status !== "match") reasons.push("IDENTITY_NOT_VERIFIED");
  if (activation.declaredSellerProtocols.length === 0) reasons.push("SELLER_PROTOCOL_NOT_DECLARED");
  else if (activation.hireability === "unreachable") reasons.push("SELLER_PROTOCOL_UNAVAILABLE");
  else if (activation.hireability === "probe_incomplete") reasons.push("SELLER_PROBE_INCOMPLETE");
  if (activation.quoteStatus !== "verified") reasons.push("QUOTE_NOT_VERIFIED");
  return {
    status: identity.status === "read_error"
      || activation.hireability === "unreachable"
      || activation.hireability === "probe_incomplete"
      ? "unavailable"
      : reasons.length === 0
        ? "qualified"
        : "not_qualified",
    reasons,
    provenance: "derived:marketplace-seller-qualification",
  };
}

export async function buildBscMarketplaceReadinessReport(
  options: BuildReadinessReportOptions,
): Promise<BscMarketplaceReadinessReport> {
  const now = options.now ?? Date.now;
  const inventory = await buildBscCandidateInventory(options.provider, now, {
    ...(options.additionalAgentIds ? { additionalAgentIds: options.additionalAgentIds } : {}),
  });
  const verification = await buildBscVerificationReport({
    provider: options.provider,
    identityReader: options.identityReader,
    inventory,
    ...(options.verifyMcp ? { verifyMcp: options.verifyMcp } : {}),
    ...(options.mcpOptions ? { mcpOptions: options.mcpOptions } : {}),
    now,
  });
  const assessHireability = options.assessHireability ?? createHireabilityAssessor();
  const candidates: ReadinessCandidate[] = [];

  for (const agent of inventory.agents) {
    const identity = verification.agents.find((entry) => entry.agentId === agent.agentId)?.identity;
    if (!identity) throw new Error(`Verification result missing for agent ${agent.agentId}`);
    const activation = await assessHireability(agent, identity);
    candidates.push({
      ...agent,
      activation,
      selection: inventory.selection.explicitAgentIds.includes(agent.agentId)
        ? "operator_explicit"
        : "curated",
      curatedCategories: curatedCategories(inventory, agent.agentId),
      qualification: qualification(activation, identity),
    });
  }

  const buyerProof = await verifyGate1Proof(options.gate1Reader, now);
  const categories = Object.fromEntries(
    (Object.keys(inventory.categories) as MarketplaceCategory[]).map((category) => {
      const source = inventory.categories[category];
      const quoteVerifiedAgentIds = candidates
        .filter((agent) =>
          agent.activation.hireability === "quote_verified"
          && agent.curatedCategories.includes(category))
        .map((agent) => agent.agentId);
      const qualifiedAgentIds = candidates
        .filter((agent) =>
          agent.qualification.status === "qualified"
          && agent.curatedCategories.includes(category))
        .map((agent) => agent.agentId);
      return [category, { ...source, quoteVerifiedAgentIds, qualifiedAgentIds }];
    }),
  ) as BscMarketplaceReadinessReport["categories"];
  const quoteVerifiedAgentIds = candidates.filter(
    (agent) => agent.activation.hireability === "quote_verified",
  ).map((agent) => agent.agentId);
  const qualifiedSellerAgentIds = candidates.filter(
    (agent) => agent.qualification.status === "qualified",
  ).map((agent) => agent.agentId);
  const qualifiedCuratedAgentIds = candidates.filter(
    (agent) => agent.qualification.status === "qualified" && agent.selection === "curated",
  ).map((agent) => agent.agentId);
  const quoteVerifiedCategories = Object.values(categories).filter(
    (category) => category.quoteVerifiedAgentIds.length > 0,
  ).length;
  const knownAgentsPresent = KNOWN_HEYANON_AGENT_IDS.every((agentId) =>
    candidates.some((candidate) => candidate.agentId === agentId));
  const identityReadsComplete = verification.agents.every(
    (agent) => agent.identity.status !== "read_error",
  );
  const blockers: string[] = [];
  if (!knownAgentsPresent) blockers.push("The four known HeyAnon candidates are not all present.");
  if (!identityReadsComplete) blockers.push("One or more direct BSC identity reads failed.");
  if (buyerProof.status !== "verified") blockers.push("Gate 1 onchain proof is not verified.");
  const warnings: string[] = [];
  if (verification.summary.status === "attention_required") {
    warnings.push("Candidate verification contains identity, endpoint, or tool drift requiring attention.");
  }
  if (quoteVerifiedCategories < 4) {
    warnings.push("Real-agent ERC-8183 activation coverage is incomplete.");
  }
  if (categories.grid_trading.status === "unverified") {
    warnings.push("Grid Trading remains explicitly empty/unverified.");
  }
  if (candidates.some((agent) => agent.activation.probe.truncated)) {
    warnings.push("One or more seller protocol probes were truncated by the bounded execution policy.");
  }
  const qualificationNeedsAttention = candidates.some((agent) =>
    agent.qualification.status === "unavailable"
    || agent.activation.probe.truncated
    || (agent.activation.declaredSellerProtocols.length > 0
      && agent.activation.hireability === "invalid_quote"),
  ) || verification.agents.some((agent) => agent.identity.status === "mismatch");
  const sellerQualification = {
    status: qualifiedSellerAgentIds.length > 0
      ? "passed" as const
      : qualificationNeedsAttention
        ? "attention_required" as const
        : "pending_no_qualified_seller" as const,
    qualifiedAgentIds: qualifiedSellerAgentIds,
    note: qualifiedSellerAgentIds.length > 0
      ? "At least one seller has matching direct identity and a currently valid signed ERC-8183 quote. Promotion remains manual."
      : "No seller currently has both matching direct identity and a valid signed ERC-8183 quote.",
  };

  return {
    schemaVersion: 2,
    generatedAt: new Date(now()).toISOString(),
    catalog: { chainId: 56, source: "trust8004", coverage: "partial" },
    verification,
    selection: inventory.selection,
    categories,
    candidates,
    activationCoverage: {
      status: quoteVerifiedCategories === 0
        ? "none"
        : quoteVerifiedCategories === 4
          ? "complete"
          : "partial",
      quoteVerifiedAgents: quoteVerifiedAgentIds.length,
      quoteVerifiedAgentIds,
      qualifiedSellerAgentIds,
      qualifiedCuratedAgentIds,
      quoteVerifiedCategories,
      requiredCategories: 4,
    },
    sellerQualification,
    buyerProof,
    frontendReady: blockers.length === 0,
    blockers,
    warnings,
  };
}

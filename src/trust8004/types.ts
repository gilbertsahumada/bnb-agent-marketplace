export const BSC_MAINNET_CHAIN_ID = 56 as const;
export const TRUST8004_BASE_URL = "https://trust8004.xyz";
export const CATALOG_COVERAGE = "partial" as const;

export type ProvenanceKind = "declared" | "observed" | "onchain" | "derived";

export interface ProvenanceRecord {
  kind: ProvenanceKind;
  source: "trust8004-public-api" | "marketplace";
  sourcePath: string;
  fetchedAt: string;
  verifiedDirectly: boolean;
  note?: string;
}

export interface NormalizedService {
  name: string;
  endpoint: string | null;
  version: string | null;
  tools: string[];
  capabilities: string[];
}

export interface NormalizedEndpoint {
  name: string | null;
  endpoint: string;
}

export type EndpointObservationStatus =
  | "not_observed"
  | "observed_ok"
  | "observed_failed";

export interface EndpointObservation {
  status: EndpointObservationStatus;
  protocol: "mcp" | "a2a" | "web" | null;
  endpoint: string | null;
  lastTestedAt: string | null;
  httpStatus: number | null;
  capabilitiesCount: number;
  requiresAuth: boolean | null;
  error: string | null;
}

export interface FeedbackSummary {
  totalFeedbacks: number;
  averageScore: number | null;
  uniqueReviewers: number;
}

export interface TrustScoreDimension {
  score: number;
  weight: number;
  weighted: number;
  confidence: number;
}

export interface TrustScore {
  total: number;
  tier: string;
  dimensions: Record<string, TrustScoreDimension>;
  calculatedAt: string;
  expiresAt: string;
}

export type MarketplaceCategory =
  | "rebalancing"
  | "grid_trading"
  | "yield_optimisation"
  | "health_factor_monitoring";

export interface CategoryEvidence {
  category: MarketplaceCategory;
  kind: "declared" | "observed";
  sourcePath: string;
  signal: string;
  value: string;
}

export interface CategoryClassification {
  category: MarketplaceCategory;
  confidence: number;
  evidence: CategoryEvidence[];
  verified: false;
}

export interface MarketplaceAgent {
  chainId: typeof BSC_MAINNET_CHAIN_ID;
  agentId: string;
  name: string;
  description: string | null;
  owner: string;
  metadataUri: string | null;
  services: NormalizedService[];
  endpoints: NormalizedEndpoint[];
  tools: string[];
  capabilities: string[];
  reputation: FeedbackSummary;
  trustScore: TrustScore;
  categories: CategoryClassification[];
  endpointObservation: EndpointObservation;
  freshness: {
    fetchedAt: string;
    metadataUpdatedAt: string | null;
    indexedUpdatedAt: string | null;
  };
  catalogCoverage: typeof CATALOG_COVERAGE;
  provenance: {
    identity: ProvenanceRecord;
    metadata: ProvenanceRecord;
    services: ProvenanceRecord;
    endpointObservation: ProvenanceRecord;
    reputation: ProvenanceRecord;
    trustScore: ProvenanceRecord;
    categories: ProvenanceRecord;
  };
}

export interface AgentListItem {
  chainId: typeof BSC_MAINNET_CHAIN_ID;
  agentId: string;
  name: string;
  description: string | null;
  owner: string | null;
  metadataUri: string | null;
  mcpEndpoint: string | null;
  a2aEndpoint: string | null;
  services: NormalizedService[];
  endpoints: NormalizedEndpoint[];
  tools: string[];
  capabilities: string[];
  endpointObservation: EndpointObservation;
  reputation: {
    totalFeedbacks: number;
    averageScore: number | null;
  };
  trustScore: {
    total: number | null;
    tier: string | null;
  };
  active: boolean | null;
  updatedAt: string | null;
}

export interface AgentListPage {
  items: AgentListItem[];
  total: number;
  limit: number;
  offset: number;
  catalogCoverage: typeof CATALOG_COVERAGE;
  fetchedAt: string;
}

export interface Trust8004Profile {
  chainId: typeof BSC_MAINNET_CHAIN_ID;
  agentId: string;
  name: string;
  description: string | null;
  owner: string;
  metadataUri: string | null;
  services: NormalizedService[];
  endpoints: NormalizedEndpoint[];
  declaredCapabilities: string[];
  endpointObservation: EndpointObservation;
  feedbackSummary: FeedbackSummary;
  metadataUpdatedAt: number | null;
  updatedAt: number | null;
  responseTimestamp: number;
}

export interface BscCandidateInventory {
  schemaVersion: 2;
  generatedAt: string;
  chainId: typeof BSC_MAINNET_CHAIN_ID;
  selection: {
    curatedAgentIds: string[];
    explicitAgentIds: string[];
    evaluatedAgentIds: string[];
  };
  source: {
    name: "trust8004";
    baseUrl: string;
    catalogCoverage: typeof CATALOG_COVERAGE;
    note: string;
  };
  categories: Record<MarketplaceCategory, {
    status: "candidates" | "unverified";
    agentIds: string[];
    note: string;
  }>;
  agents: MarketplaceAgent[];
}

import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type FetchLike,
} from "@modelcontextprotocol/client";
import type { McpEndpointVerification, McpVerificationStatus } from "./types.js";
import {
  createSafeEndpointTransport,
  resolveSafePublicHttpsEndpoint,
  type ResolveHostname,
  type SafeEndpointTransport,
} from "./safe-http.js";

export { isPublicIpAddress } from "./safe-http.js";
export type { ResolveHostname } from "./safe-http.js";

export interface McpVerifierOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  timeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

export async function assertSafeMcpEndpoint(
  endpoint: string,
  resolveHostname?: ResolveHostname,
): Promise<URL> {
  return (await resolveSafePublicHttpsEndpoint(endpoint, resolveHostname)).url;
}

function compareTools(declaredTools: string[], observedTools: string[]): {
  matched: string[];
  declaredOnly: string[];
  observedOnly: string[];
} {
  const declared = new Set(declaredTools);
  const observed = new Set(observedTools);
  return {
    matched: [...declared].filter((tool) => observed.has(tool)).sort(),
    declaredOnly: [...declared].filter((tool) => !observed.has(tool)).sort(),
    observedOnly: [...observed].filter((tool) => !declared.has(tool)).sort(),
  };
}

function classifyError(error: unknown): { status: McpVerificationStatus; code: string; message: string } {
  if (UnauthorizedError.isInstance(error)) {
    return { status: "unauthorized", code: "MCP_UNAUTHORIZED", message: "Endpoint requires authentication." };
  }
  if (SdkHttpError.isInstance(error)) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return { status: "unauthorized", code: "MCP_UNAUTHORIZED", message: "Endpoint requires authentication." };
    }
    return {
      status: "http_error",
      code: `MCP_HTTP_${status}`,
      message: `Endpoint returned HTTP ${status}.`,
    };
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "AbortError" || name === "TimeoutError" || message.includes("timeout")) {
    return { status: "timeout", code: "MCP_TIMEOUT", message: "Endpoint request timed out." };
  }
  return {
    status: "protocol_error",
    code: "MCP_PROTOCOL_ERROR",
    message: "Endpoint did not complete a valid MCP discovery flow.",
  };
}

export async function verifyMcpEndpoint(
  endpoint: string,
  declaredTools: string[],
  options: McpVerifierOptions = {},
): Promise<McpEndpointVerification> {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  const observedAt = new Date(now()).toISOString();
  const timeoutMs = options.timeoutMs ?? 10_000;
  let safeUrl: URL;
  let safeTransport: SafeEndpointTransport;

  try {
    safeTransport = await createSafeEndpointTransport(endpoint, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
      timeoutMs,
    });
    safeUrl = safeTransport.url;
  } catch {
    return {
      status: "unsafe_url",
      endpoint,
      protocol: "mcp",
      declaredTools: [...new Set(declaredTools)].sort(),
      observedTools: [],
      comparison: compareTools(declaredTools, []),
      negotiatedProtocolVersion: null,
      serverInfo: null,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      observedAt,
      provenance: "observed:mcp-tools-list",
      error: { code: "MCP_UNSAFE_URL", message: "Endpoint is not a safe public HTTPS URL." },
    };
  }

  const controlledFetch = safeTransport.fetch as FetchLike;
  const client = new Client(
    { name: "bnb-agent-marketplace-verifier", version: "0.0.0" },
    {
      supportedProtocolVersions: ["2025-06-18"],
      enforceStrictCapabilities: true,
      listMaxPages: 20,
    },
  );
  const transport = new StreamableHTTPClientTransport(safeUrl, { fetch: controlledFetch });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const observedTools = [...new Set(result.tools.map((tool) => tool.name))].sort();
    const comparison = compareTools(declaredTools, observedTools);
    const server = client.getServerVersion();
    return {
      status: observedTools.length > 0 ? "protocol_valid" : "no_tools",
      endpoint,
      protocol: "mcp",
      declaredTools: [...new Set(declaredTools)].sort(),
      observedTools,
      comparison,
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverInfo: server ? { name: server.name, version: server.version } : null,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      observedAt,
      provenance: "observed:mcp-tools-list",
      error: observedTools.length > 0
        ? null
        : { code: "MCP_NO_TOOLS", message: "MCP discovery succeeded but returned no tools." },
    };
  } catch (error) {
    const classified = classifyError(error);
    return {
      status: classified.status,
      endpoint,
      protocol: "mcp",
      declaredTools: [...new Set(declaredTools)].sort(),
      observedTools: [],
      comparison: compareTools(declaredTools, []),
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverInfo: null,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      observedAt,
      provenance: "observed:mcp-tools-list",
      error: { code: classified.code, message: classified.message },
    };
  } finally {
    if (transport.sessionId) await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    await safeTransport.close().catch(() => undefined);
  }
}

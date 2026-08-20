import { randomUUID } from "node:crypto";
import { readBoundedJson } from "./verification/bounded-json.js";

export interface AgentCard {
  name: string;
  url: string;
  skills: Array<{ id: string }>;
}

export type QuoteEnvelope = Record<string, unknown> & {
  provider_address: string;
  response: { terms: { price: string; currency?: string } };
  negotiation_hash?: string;
  provider_sig?: string;
};

interface RpcReply {
  error?: { message?: string };
  result?: { parts?: Array<{ data?: Record<string, unknown> }> };
}

const MAX_A2A_RESPONSE_BYTES = 64 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  return readBoundedJson(response, {
    maxBytes: MAX_A2A_RESPONSE_BYTES,
    tooLargeMessage: "A2A response exceeded the allowed size",
    invalidJsonMessage: "A2A response was not valid JSON",
  });
}

export function agentCardUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/.well-known/agent-card.json")) {
    url.pathname = `${path}/.well-known/agent-card.json`;
  }
  return url.toString();
}

function headers(bearerToken: string | null): Record<string, string> {
  return bearerToken
    ? { authorization: `Bearer ${bearerToken}` }
    : {};
}

export async function fetchAgentCard(
  endpoint: string,
  bearerToken: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentCard> {
  const response = await fetchImpl(agentCardUrl(endpoint), {
    headers: headers(bearerToken),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Agent Card returned HTTP ${response.status}`);
  }
  const card = (await boundedJson(response)) as Partial<AgentCard>;
  if (
    typeof card.name !== "string" ||
    typeof card.url !== "string" ||
    !Array.isArray(card.skills) ||
    !card.skills.every(
      (skill) => typeof skill === "object" && skill !== null && typeof skill.id === "string",
    )
  ) {
    throw new Error("Agent Card has an invalid shape");
  }
  const endpointOrigin = new URL(endpoint).origin;
  const messageOrigin = new URL(card.url).origin;
  if (endpointOrigin !== messageOrigin) {
    throw new Error(
      `Agent Card message origin changed from ${endpointOrigin} to ${messageOrigin}`,
    );
  }
  return card as AgentCard;
}

export async function sendSkill(
  messageUrl: string,
  data: Record<string, unknown>,
  bearerToken: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(messageUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(bearerToken),
    },
    redirect: "error",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: randomUUID(),
          parts: [{ kind: "data", data }],
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`A2A message returned HTTP ${response.status}`);
  }
  const reply = (await boundedJson(response)) as RpcReply;
  if (reply.error) {
    throw new Error("A2A returned a protocol error");
  }
  const result = reply.result?.parts?.[0]?.data;
  if (!result) throw new Error("A2A reply has no data part");
  return result;
}

export async function negotiate(
  messageUrl: string,
  bearerToken: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteEnvelope> {
  return (await sendSkill(
    messageUrl,
    {
      skill: "negotiate-erc8183-job",
      task_description: "Gate 1 ERC-8183 buyer spike",
      terms: {
        deliverables: "A deterministic text receipt proving seller execution",
        quality_standards: "Return a non-empty result and submit it onchain",
      },
    },
    bearerToken,
    fetchImpl,
  )) as QuoteEnvelope;
}

export async function notifyFunded(
  messageUrl: string,
  jobId: bigint,
  bearerToken: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return sendSkill(
    messageUrl,
    { skill: "notify_funded", job_id: Number(jobId) },
    bearerToken,
    fetchImpl,
  );
}

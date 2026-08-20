import { describe, expect, it, vi } from "vitest";
import { agentCardUrl, fetchAgentCard, sendSkill } from "../src/a2a.js";

describe("A2A transport", () => {
  it("builds the well-known URL before a query string", () => {
    expect(agentCardUrl("https://agent.example/a2a?mode=test")).toBe(
      "https://agent.example/a2a/.well-known/agent-card.json?mode=test",
    );
  });

  it("rejects an Agent Card that changes origin", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ name: "seller", url: "https://evil.example/a2a", skills: [] }),
        { status: 200 },
      ),
    );
    await expect(
      fetchAgentCard("https://seller.example", null, fakeFetch),
    ).rejects.toThrow(/origin changed/);
  });

  it("rejects malformed Agent Card skills", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      Response.json({ name: "seller", url: "https://seller.example/a2a", skills: [{}] }),
    );
    await expect(
      fetchAgentCard("https://seller.example", null, fakeFetch),
    ).rejects.toThrow(/invalid shape/);
  });

  it("sends bearer credentials without returning them", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: { parts: [{ data: { accepted: true } }] } }),
        { status: 200 },
      ),
    );
    await expect(
      sendSkill("https://seller.example/a2a", { skill: "test" }, "token", fakeFetch),
    ).resolves.toEqual({ accepted: true });
    expect(fakeFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer token",
    });
  });

  it("rejects oversized A2A responses before parsing", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("{}", { headers: { "content-length": "70000" } }),
    );
    await expect(
      fetchAgentCard("https://seller.example", null, fakeFetch),
    ).rejects.toThrow(/allowed size/);
  });

  it("cancels an oversized chunked A2A response without buffering the remainder", async () => {
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
    const fakeFetch = vi.fn().mockResolvedValue(new Response(body));

    await expect(
      fetchAgentCard("https://seller.example", null, fakeFetch),
    ).rejects.toThrow(/allowed size/);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });
});

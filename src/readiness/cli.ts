import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_HEYANON_AGENT_IDS,
  MAX_EXPLICIT_QUALIFICATION_AGENT_IDS,
  MAX_UINT256_AGENT_ID,
} from "../trust8004/inventory.js";
import { Trust8004HttpError, Trust8004Provider } from "../trust8004/provider.js";
import { createBscIdentityReader } from "../verification/onchain.js";
import { createGate1ProofReader } from "./gate1.js";
import { buildBscMarketplaceReadinessReport } from "./report.js";
import type { BscMarketplaceReadinessReport } from "./types.js";

export interface ReadinessCliArguments {
  outputPath: string;
  additionalAgentIds: string[];
}

export function parseReadinessArgs(args: string[]): ReadinessCliArguments {
  let outputPath = resolve(".marketplace/readiness/bsc-marketplace.json");
  const additionalAgentIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--output" && argument !== "--agent-id") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--output") {
      outputPath = resolve(value);
      continue;
    }
    if (!/^\d+$/.test(value)) throw new Error(`--agent-id must be numeric: ${value}`);
    const numericAgentId = BigInt(value);
    if (numericAgentId > MAX_UINT256_AGENT_ID) {
      throw new Error(`--agent-id exceeds uint256: ${value}`);
    }
    const normalized = numericAgentId.toString();
    if (!additionalAgentIds.includes(normalized)) additionalAgentIds.push(normalized);
  }
  const curatedIds = new Set<string>(KNOWN_HEYANON_AGENT_IDS);
  const explicitCount = additionalAgentIds.filter((agentId) => !curatedIds.has(agentId)).length;
  if (explicitCount > MAX_EXPLICIT_QUALIFICATION_AGENT_IDS) {
    throw new Error(`At most ${MAX_EXPLICIT_QUALIFICATION_AGENT_IDS} explicit agent IDs may be evaluated`);
  }
  return { outputPath, additionalAgentIds };
}

export function parseOutputPath(args: string[]): string {
  return parseReadinessArgs(args).outputPath;
}

export function readinessExitCode(report: BscMarketplaceReadinessReport): 0 | 2 {
  return report.frontendReady ? 0 : 2;
}

export async function writeReadinessReport(
  destination: string,
  report: BscMarketplaceReadinessReport,
): Promise<void> {
  const directory = dirname(destination);
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function readinessFatalMessage(error: unknown): string {
  if (error instanceof Trust8004HttpError) {
    return `TRUST8004_HTTP_${error.status}: the public catalogue request failed.`;
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "TRUST8004_UNAVAILABLE: the public catalogue request timed out.";
  }
  if (error instanceof Error && /trust8004 schema error/i.test(error.message)) {
    return "TRUST8004_SCHEMA_INVALID: the public catalogue response did not match the expected schema.";
  }
  if (error instanceof Error && /^(Unknown argument|--(?:output|agent-id)|At most \d+ explicit agent IDs)/.test(error.message)) {
    return `INVALID_ARGUMENT: ${error.message}`;
  }
  return "READINESS_FAILED: seller qualification did not complete successfully.";
}

async function main(): Promise<void> {
  const args = parseReadinessArgs(process.argv.slice(2));
  const report = await buildBscMarketplaceReadinessReport({
    provider: new Trust8004Provider(),
    identityReader: createBscIdentityReader(),
    gate1Reader: await createGate1ProofReader(),
    additionalAgentIds: args.additionalAgentIds,
  });
  await writeReadinessReport(args.outputPath, report);
  process.stdout.write(
    `Wrote BSC marketplace readiness report to ${args.outputPath} (sellerQualification=${report.sellerQualification.status}, frontendReady=${report.frontendReady})\n`,
  );
  process.exitCode = readinessExitCode(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`BSC readiness failed: ${readinessFatalMessage(error)}\n`);
    process.exitCode = 1;
  });
}

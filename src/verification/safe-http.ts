import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export type ResolveHostname = (hostname: string) => Promise<string[]>;

export interface SafeEndpointTransport {
  url: URL;
  fetch: typeof fetch;
  close: () => Promise<void>;
}

export interface SafeEndpointTransportOptions {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  timeoutMs?: number;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version === 6) return !isPrivateIpv6(address);
  return false;
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

export async function resolveSafePublicHttpsEndpoint(
  endpoint: string,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("Endpoint URL must not contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Endpoint hostname is not public");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("Endpoint does not resolve exclusively to public IP addresses");
  }
  return { url, addresses: [...new Set(addresses)] };
}

export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const records = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
        ? 6
        : options.family ?? 0;
    const matching = requestedFamily === 0
      ? records
      : records.filter((record) => record.family === requestedFamily);
    if (matching.length === 0) {
      const error = Object.assign(new Error("No validated address matches the requested family"), {
        code: "ENOTFOUND",
      });
      callback(error, []);
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0]!.address, matching[0]!.family);
  };
}

export async function createSafeEndpointTransport(
  endpoint: string,
  options: SafeEndpointTransportOptions = {},
): Promise<SafeEndpointTransport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  const resolutionTimeout = new Promise<never>((_resolve, reject) => {
    resolutionTimer = setTimeout(() => reject(new DOMException("DNS resolution timed out", "TimeoutError")), timeoutMs);
  });
  let resolved: Awaited<ReturnType<typeof resolveSafePublicHttpsEndpoint>>;
  try {
    resolved = await Promise.race([
      resolveSafePublicHttpsEndpoint(endpoint, options.resolveHostname),
      resolutionTimeout,
    ]);
  } finally {
    if (resolutionTimer) clearTimeout(resolutionTimer);
  }
  const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const dispatcher = options.fetch
    ? null
    : new Agent({ connect: { lookup: createPinnedLookup(resolved.addresses) } });
  const fetchImpl = options.fetch ?? fetch;
  const transportTimeoutSignal = AbortSignal.timeout(remainingTimeoutMs);
  const controlledFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (requestedUrl.protocol !== "https:" || requestedUrl.origin !== resolved.url.origin) {
      throw new Error("Protocol probe attempted to leave the validated origin");
    }
    const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = existingSignal
      ? AbortSignal.any([existingSignal, transportTimeoutSignal])
      : transportTimeoutSignal;
    const requestInit = {
      ...init,
      redirect: "error" as const,
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit;
    return fetchImpl(input, requestInit);
  }) as typeof fetch;
  return {
    url: resolved.url,
    fetch: controlledFetch,
    close: async () => {
      if (dispatcher) await dispatcher.close();
    },
  };
}

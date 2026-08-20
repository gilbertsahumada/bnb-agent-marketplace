export interface BoundedJsonOptions {
  maxBytes: number;
  tooLargeMessage: string;
  invalidJsonMessage: string;
}

export async function readBoundedJson(
  response: Response,
  options: BoundedJsonOptions,
): Promise<unknown> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(options.tooLargeMessage);
    }
  }
  if (!response.body) throw new Error(options.invalidJsonMessage);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(options.tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(options.invalidJsonMessage);
  }
}

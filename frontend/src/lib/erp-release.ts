export interface ErpReleaseObservation {
  runtime: 'nest';
  observedAt: string;
  releaseSha: string | null;
}

/** Observe only the fixed public ERP projection. Missing SHA stays unknown. */
export async function getErpReleaseObservation(): Promise<ErpReleaseObservation | null> {
  try {
    const response = await fetch('https://app.financioflow.com/api/server-info', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json', 'User-Agent': 'Financio-Trust-Center-Status/1.0' },
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== 'object') return null;
    const input = value as Record<string, unknown>;
    if (input.ok !== true || input.runtime !== 'nest' || typeof input.instanceId !== 'string' || input.instanceId.length < 1 || input.instanceId.length > 128) return null;
    return { runtime: 'nest', observedAt: new Date().toISOString(),
      releaseSha: typeof input.release === 'string' && /^[a-f0-9]{40}$/.test(input.release) ? input.release : null };
  } catch { return null; }
}

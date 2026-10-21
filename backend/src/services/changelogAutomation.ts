import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { draftFromEvidence } from './changelogEvidence';

const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const actorSchema = z.object({ id: z.string().uuid(), email: z.string().email().max(320) });
const rowSchema = z.object({ id: z.string().uuid(), state: z.enum(['draft', 'published', 'rejected']), revision: z.number().int().positive(), evidence: z.record(z.string(), z.unknown()) });
const cursorSchema = z.object({ schemaVersion: z.literal(1), pending: z.object({ collectionKey: keySchema, sha: z.string().regex(/^[a-f0-9]{40}$/), preparedAt: z.string().datetime() }).nullable(), last: z.object({ collectionKey: keySchema, draftId: z.string().uuid(), draftState: z.enum(['draft', 'published', 'rejected']) }).nullable() }).strict();
export type AutomationCursor = z.infer<typeof cursorSchema>;
export type DraftRow = z.infer<typeof rowSchema>;
type CollectedDraft = ReturnType<typeof draftFromEvidence>;
export interface ReceiptStore { read(): AutomationCursor; write(value: AutomationCursor): void }
export class CollectionError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}
export function automationConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.TRUST_CENTER_AUTOMATION_ENABLED !== 'true') return { enabled: false as const };
  const actor = actorSchema.safeParse({ id: env.TRUST_CENTER_AUTOMATION_ACTOR_ID, email: env.TRUST_CENTER_AUTOMATION_ACTOR_EMAIL });
  if (!actor.success) throw new CollectionError('configured_administrator_delegate_required');
  return { enabled: true as const, actor: actor.data };
}
export function observationKey(evidence: CollectedDraft['evidence']): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, generator: evidence.generator, repository: evidence.repository, sha: evidence.sha,
    ci: { state: evidence.ci.state, source: evidence.ci.source }, securityChecks: evidence.securityChecks.observations,
  })).digest('hex');
}
function matchingRow(value: unknown, key: string): DraftRow {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success || (parsed.data.evidence.automation as { collectionKey?: string } | undefined)?.collectionKey !== key) throw new CollectionError('invalid_collection_reconciliation');
  return parsed.data;
}
function resultFor(status: string, key: string, row: DraftRow) { return { status, collectionKey: key, draftId: row.id, draftState: row.state }; }

/** Caller must hold the canonical shared flock for the entire operation.
 * Only the existing private generation RPC is permitted; no publication RPC.
 */
export async function runAutomaticCollection(config: ReturnType<typeof automationConfig>, deps: {
  collect(): Promise<CollectedDraft>;
  find(collectionKey: string): Promise<unknown[]>;
  create(args: { p_title: string; p_content: string; p_evidence: Record<string, unknown>; p_actor_id: string; p_actor_email: string }): Promise<{ data: unknown; error: { code?: string } | null }>;
  receipts: ReceiptStore;
}) {
  if (!config.enabled) return { status: 'disabled' };
  let cursor = deps.receipts.read();
  async function find(key: string) {
    let rows: unknown[];
    try { rows = await deps.find(key); } catch { throw new CollectionError('reconciliation_unavailable'); }
    if (rows.length > 1) throw new CollectionError('multiple_matching_drafts_require_review');
    return rows.length === 1 ? matchingRow(rows[0], key) : null;
  }
  function confirmed(key: string, row: DraftRow) {
    cursor = { schemaVersion: 1, pending: null, last: { collectionKey: key, draftId: row.id, draftState: row.state } };
    deps.receipts.write(cursor);
  }
  // An interrupted/ambiguous previous request fences ALL newer observations.
  if (cursor.pending) {
    const pending = cursor.pending;
    const row = await find(pending.collectionKey);
    if (!row) throw new CollectionError('previous_write_outcome_unknown');
    confirmed(pending.collectionKey, row);
  }
  const draft = await deps.collect();
  const key = observationKey(draft.evidence);
  const existing = await find(key);
  if (existing) { confirmed(key, existing); return resultFor('existing', key, existing); }
  if (cursor.last?.collectionKey === key) throw new CollectionError('confirmed_draft_missing_requires_review');

  cursor = { ...cursor, pending: { collectionKey: key, sha: draft.evidence.sha, preparedAt: new Date().toISOString() } };
  deps.receipts.write(cursor); // fsync before the network write; never blindly replay.
  const evidence = { ...draft.evidence, automation: { collector: 'financio-trust-draft-collector-v1', collectionKey: key,
    onBehalfOf: { administratorId: config.actor.id, administratorEmail: config.actor.email },
    disposition: 'private_draft_for_human_review', source: 'scheduled_collection',
  } };
  let response: { data: unknown; error: { code?: string } | null } | undefined;
  try {
    response = await deps.create({ p_title: draft.title, p_content: draft.content, p_evidence: evidence,
      p_actor_id: config.actor.id, p_actor_email: config.actor.email });
  } catch { /* Reconcile before deciding whether the request committed. */ }
  if (response?.error && ['42501', '22023', 'P0002', 'PT409', '23505', '23514', '23502', 'PGRST202'].includes(response.error.code || '')) {
    // Explicit PostgreSQL/argument rejection confirms no generation committed.
    cursor = { ...cursor, pending: null }; deps.receipts.write(cursor);
    throw new CollectionError('draft_creation_rejected');
  }
  if (response && !response.error) {
    try {
      const row = matchingRow(response.data, key);
      if (row.state !== 'draft') throw new CollectionError('unexpected_generation_state');
      confirmed(key, row); return resultFor('created', key, row);
    } catch { /* Invalid/lost successful response is also an ambiguous outcome. */ }
  }
  const reconciled = await find(key);
  if (reconciled) { confirmed(key, reconciled); return resultFor('reconciled', key, reconciled); }
  throw new CollectionError('write_outcome_unknown');
}

/** Private durable ambiguity receipt, mounted outside the document volume. */
export function privateReceiptStore(directory: string): ReceiptStore {
  const meta = fs.lstatSync(directory);
  if (!meta.isDirectory() || meta.isSymbolicLink() || meta.uid !== process.getuid?.() || (meta.mode & 0o077)) throw new CollectionError('private_receipt_directory_required');
  const destination = path.join(directory, 'collection-state.json');
  function checkFile() {
    const s = fs.lstatSync(destination);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > 32768) throw new CollectionError('invalid_private_receipt');
  }
  return {
    read() {
      try { checkFile(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, pending: null, last: null };
        throw error;
      }
      try { return cursorSchema.parse(JSON.parse(fs.readFileSync(destination, 'utf8'))); } catch { throw new CollectionError('invalid_private_receipt'); }
    },
    write(value) {
      const validated = cursorSchema.parse(value);
      if (fs.existsSync(destination) || (() => { try { fs.lstatSync(destination); return true; } catch { return false; } })()) checkFile();
      const temporary = path.join(directory, `.collection-${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(validated)); fs.fsyncSync(fd); fs.closeSync(fd);
        fs.renameSync(temporary, destination);
        const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } catch (error) { try { fs.closeSync(fd); } catch { /* already closed */ } try { fs.unlinkSync(temporary); } catch { /* already renamed */ } throw error; }
    },
  };
}

import { createClient } from '@supabase/supabase-js';
import { automationConfig, CollectionError, privateReceiptStore, runAutomaticCollection } from '../services/changelogAutomation';
import { collectDraft } from '../services/changelogEvidence';

async function main() {
  const config = automationConfig();
  if (!config.enabled) { console.log(JSON.stringify({ status: 'disabled' })); return; }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !process.env.TRUST_CENTER_GITHUB_TOKEN) throw new CollectionError('existing_dedicated_bindings_required');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new CollectionError('verified_supabase_https_origin_required');
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) } });
  const result = await runAutomaticCollection(config, {
    collect: () => collectDraft(),
    receipts: privateReceiptStore('/var/lib/financio-trust-automation'),
    async find(collectionKey) {
      const { data, error } = await client.from('changelog_drafts').select('id,state,revision,evidence').eq('evidence->automation->>collectionKey', collectionKey).limit(2);
      if (error || !Array.isArray(data)) throw new CollectionError('reconciliation_unavailable');
      return data;
    },
    async create(args) {
      const { data, error } = await client.rpc('create_changelog_draft', args).retry(false);
      return { data, error };
    },
  });
  console.log(JSON.stringify(result)); // No content, email, credential or raw provider error.
}
main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', reason: error instanceof CollectionError ? error.reason : 'collection_unavailable' }));
  process.exitCode = 1;
});

import { PGlite } from '@electric-sql/pglite';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repository = path.resolve(__dirname, '../../../..');
const initializer = path.join(repository, 'scripts/init-financio-database.sh');
// Backend uses legacy TypeScript moduleResolution; Node resolves contrib exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');

function initializationSql() {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-center-init-test-'));
  try {
    // Capture the initializer transaction, never contact an external database.
    fs.writeFileSync(path.join(tools, 'psql'), '#!/bin/sh\nfor arg in "$@"; do\ncase "$arg" in --file=*) cat -- "${arg#--file=}";; esac\ndone\n', { mode: 0o700 });
    const output = execFileSync('bash', [initializer], {
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, PGHOST: 'unused.example.test', PGDATABASE: 'unused', PGUSER: 'unused', TRUST_CENTER_DATABASE_PURPOSE: 'financio-trust-center' },
      encoding: 'utf8',
    });
    return output.slice(0, output.lastIndexOf('COMMIT;') + 'COMMIT;'.length);
  } finally { fs.rmSync(tools, { recursive: true, force: true }); }
}

async function nativeSupabaseFixture(database: PGlite) {
  await database.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE SCHEMA extensions;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'anon'::text $$;
    CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;
  `);
}

describe('Fresh dedicated Trust Center database initialization', () => {
  it('applies the real migrations without demo assertions or replacing native auth, and refuses reruns', async () => {
    const sql = initializationSql();
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION auth.uid()');
    expect(sql).not.toContain('We maintain ISO 27001');
    const database = new PGlite({ extensions: { uuid_ossp } });
    try {
      await nativeSupabaseFixture(database);
      await database.exec(sql);
      expect((await database.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.buckets'::regclass")).rows[0]).toEqual({ relrowsecurity: true });
      const counts = await database.query('SELECT (SELECT count(*) FROM controls)::int AS controls, (SELECT count(*) FROM certifications)::int AS certifications, (SELECT count(*) FROM security_updates)::int AS updates');
      expect(counts.rows[0]).toEqual({ controls: 0, certifications: 0, updates: 0 });
      expect((await database.query('SELECT auth.uid() AS id')).rows[0]).toEqual({ id: '00000000-0000-0000-0000-000000000001' });
      const branding = await database.query('SELECT company_name, contact_email, footer_text, admin_nav_order FROM trust_center_settings');
      expect(branding.rows[0]).toMatchObject({ company_name: 'Financio Flow', contact_email: null, footer_text: null });
      expect((branding.rows[0] as { admin_nav_order: string[] }).admin_nav_order).not.toContain('integrations');
      for (const helper of ['public.create_user_with_password(text,text,text,boolean,text)', 'public.update_user_password(uuid,text)', 'public.get_all_users()']) {
        for (const role of ['anon', 'authenticated']) {
          const permission = await database.query('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS allowed', [role, helper]);
          expect(permission.rows[0]).toEqual({ allowed: false });
        }
        const permission = await database.query('SELECT has_function_privilege(\'service_role\', $1, \'EXECUTE\') AS allowed', [helper]);
        expect(permission.rows[0]).toEqual({ allowed: true });
      }
      expect((await database.query("SELECT has_table_privilege('anon', 'public.trust_center_settings', 'SELECT') AS allowed")).rows[0]).toEqual({ allowed: false });
      expect((await database.query("SELECT has_table_privilege('service_role', 'public.trust_center_settings', 'SELECT') AS allowed")).rows[0]).toEqual({ allowed: true });
      for (const role of ['anon', 'authenticated']) {
        expect((await database.query("SELECT has_column_privilege($1, 'public.security_updates', 'source_draft_id', 'SELECT') AS allowed", [role])).rows[0]).toEqual({ allowed: false });
        expect((await database.query("SELECT has_column_privilege($1, 'public.security_updates', 'content', 'SELECT') AS allowed", [role])).rows[0]).toEqual({ allowed: true });
      }
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await database.query("SELECT has_sequence_privilege($1, 'public.changelog_review_events_id_seq', 'UPDATE') AS allowed", [role])).rows[0]).toEqual({ allowed: false });
      }
      expect((await database.query("SELECT has_column_privilege('service_role', 'public.security_updates', 'source_draft_id', 'SELECT') AS allowed")).rows[0]).toEqual({ allowed: true });
      await database.exec("INSERT INTO security_updates(title,content,published_at) VALUES ('Public title','Public wording',now()); SET ROLE anon");
      expect((await database.query('SELECT title,content FROM security_updates')).rows).toEqual([{ title: 'Public title', content: 'Public wording' }]);
      await expect(database.query('SELECT source_draft_id FROM security_updates')).rejects.toMatchObject({ code: '42501' });
      await database.exec('RESET ROLE');
      await database.exec('SET ROLE authenticated');
      expect((await database.query('SELECT company_name FROM trust_center_settings')).rows).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec("INSERT INTO auth.users(id,email) VALUES ('00000000-0000-0000-0000-000000000001','admin@example.test'); INSERT INTO admin_users(id,email) VALUES ('00000000-0000-0000-0000-000000000001','admin@example.test')");
      await database.exec('SET ROLE authenticated');
      expect((await database.query('SELECT company_name FROM trust_center_settings')).rows).toEqual([{ company_name: 'Financio Flow' }]);
      await database.exec('RESET ROLE');
      await expect(database.exec(sql)).rejects.toThrow(/Fresh database required/);
      await database.exec('ROLLBACK');
      expect((await database.query('SELECT count(*)::int AS count FROM trust_center_settings')).rows[0]).toEqual({ count: 1 });
    } finally { await database.close(); }
  }, 30000);

  it('preserves provider-owned storage RLS without requiring ownership, and fails closed if it is disabled', async () => {
    const migration = fs.readFileSync(path.join(repository, 'supabase/migrations/032_security_hardening.sql'), 'utf8');
    const storageRls = migration.slice(migration.indexOf('-- Enable RLS on storage.buckets'), migration.indexOf('CREATE POLICY "Anyone can view buckets"'));
    const database = new PGlite();
    try {
      await nativeSupabaseFixture(database);
      await database.exec(`
        CREATE ROLE supabase_storage_admin;
        CREATE ROLE trust_migration;
        GRANT USAGE ON SCHEMA storage TO trust_migration;
        ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
        SET ROLE trust_migration;
      `);
      await expect(database.exec('ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: '42501' });
      await database.exec(storageRls);
      expect((await database.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.buckets'::regclass")).rows[0]).toEqual({ relrowsecurity: true });
      await database.exec('RESET ROLE; ALTER TABLE storage.buckets DISABLE ROW LEVEL SECURITY; SET ROLE trust_migration');
      await expect(database.exec(storageRls)).rejects.toMatchObject({ code: '42501' });
      expect((await database.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.buckets'::regclass")).rows[0]).toEqual({ relrowsecurity: false });
    } finally { await database.close(); }
  }, 30000);

  it('preserves existing custom branding when migration036 is applied independently', async () => {
    const database = new PGlite({ extensions: { uuid_ossp } });
    try {
      await nativeSupabaseFixture(database);
      await database.exec(initializationSql());
      await database.exec("UPDATE trust_center_settings SET company_name='Custom Company', hero_title='Custom heading', primary_color='#abcdef', footer_text='Custom footer', contact_email='contact@example.test', admin_nav_order=ARRAY['settings','integrations','documents']");
      const migration = fs.readFileSync(path.join(repository, 'supabase/migrations/036_financio_branding.sql'), 'utf8');
      await database.exec(migration);
      const settings = await database.query('SELECT company_name, hero_title, primary_color, footer_text, contact_email, admin_nav_order FROM trust_center_settings');
      expect(settings.rows[0]).toEqual({ company_name: 'Custom Company', hero_title: 'Custom heading', primary_color: '#abcdef', footer_text: 'Custom footer', contact_email: 'contact@example.test', admin_nav_order: ['settings', 'documents'] });
    } finally { await database.close(); }
  }, 30000);
});

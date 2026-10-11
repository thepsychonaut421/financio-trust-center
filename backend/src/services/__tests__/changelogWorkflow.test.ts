import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const actor = '00000000-0000-4000-8000-000000000001';
const email = 'reviewer@example.com';
describe('Transactional changelog review (PostgreSQL engine)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE admin_users(id uuid PRIMARY KEY,email text NOT NULL);
      CREATE TABLE security_updates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text,content text,published_at timestamptz);
      INSERT INTO admin_users VALUES ('${actor}','${email}');`);
    await db.exec(readFileSync(resolve(__dirname, '../../../../supabase/migrations/035_assisted_changelog.sql'), 'utf8'));
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => { await db.exec('RESET ROLE; TRUNCATE security_updates,changelog_review_events,changelog_drafts CASCADE'); });
  async function create() {
    const result = await db.query<{ id: string; revision: number }>('SELECT * FROM create_changelog_draft($1,$2,$3::jsonb,$4::uuid,$5)', ['Draft title', 'Reviewed public summary', '{"sha":"private-source"}', actor, email]);
    return result.rows[0];
  }
  function act(id: string, revision: number, action: string, note = 'Evidence reviewed') {
    return db.query('SELECT * FROM review_changelog_draft($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8)', [id, revision, action, 'Edited title', 'Edited public summary', note, actor, email]);
  }
  async function count(table: string) { return (await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${table}`)).rows[0].total; }
  test('generation stays private and edit invalidates the prior review revision', async () => {
    const draft = await create();
    expect(await count('security_updates')).toBe(0);
    await act(draft.id, 1, 'edit');
    await expect(act(draft.id, 1, 'publish')).rejects.toMatchObject({ code: '40001' });
    expect(await count('security_updates')).toBe(0);
    await act(draft.id, 2, 'publish');
    expect(await count('security_updates')).toBe(1);
    expect(await count('changelog_review_events')).toBe(3);
    const entry = (await db.query<{ title: string }>('SELECT title FROM security_updates')).rows[0];
    expect(entry.title).toBe('Edited title');
  });
  test('two reviews of the same revision result in one publication', async () => {
    const draft = await create();
    const results = await Promise.allSettled([act(draft.id, 1, 'publish'), act(draft.id, 1, 'publish')]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await count('security_updates')).toBe(1);
    expect(await count('changelog_review_events')).toBe(2);
  });
  test('rejection is recorded without publication and cannot later be silently published', async () => {
    const draft = await create(); await act(draft.id, 1, 'reject');
    await expect(act(draft.id, 2, 'publish')).rejects.toMatchObject({ code: '40001' });
    expect(await count('security_updates')).toBe(0);
  });
  test('audit failure rolls back the state transition and public entry', async () => {
    const draft = await create();
    await db.exec(`CREATE FUNCTION reject_test_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.note = 'reject-audit-test' THEN RAISE EXCEPTION 'Test audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER audit_failure_test BEFORE INSERT ON changelog_review_events FOR EACH ROW EXECUTE FUNCTION reject_test_review();`);
    try {
      await expect(act(draft.id, 1, 'publish', 'reject-audit-test')).rejects.toThrow();
      expect(await count('security_updates')).toBe(0);
      expect(await count('changelog_review_events')).toBe(1);
      expect((await db.query<{ state: string }>('SELECT state FROM changelog_drafts')).rows[0].state).toBe('draft');
    } finally { await db.exec('DROP TRIGGER audit_failure_test ON changelog_review_events; DROP FUNCTION reject_test_review()'); }
  });
  test('direct table writes cannot link an unreviewed draft or alter published history', async () => {
    const draft = await create();
    await expect(db.query('INSERT INTO security_updates(title,content,published_at,source_draft_id) VALUES ($1,$2,now(),$3::uuid)', ['Draft title', 'Reviewed public summary', draft.id])).rejects.toMatchObject({ code: '42501' });
    await db.exec("INSERT INTO security_updates(title,content,published_at) VALUES ('Legacy','Legacy',now())");
    await expect(db.query('UPDATE security_updates SET source_draft_id=$1::uuid', [draft.id])).rejects.toMatchObject({ code: '42501' });
    await act(draft.id, 1, 'publish');
    await expect(db.exec("UPDATE security_updates SET content='Changed' WHERE source_draft_id IS NOT NULL")).rejects.toMatchObject({ code: '42501' });
    await expect(db.exec('DELETE FROM changelog_review_events')).rejects.toMatchObject({ code: '42501' });
  });
  test.each(['anon', 'authenticated'])('%s cannot read private evidence or invoke reviewer RPCs', async role => {
    await create(); await db.exec(`SET ROLE ${role}`);
    await expect(db.exec('SELECT * FROM changelog_drafts')).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('SELECT * FROM create_changelog_draft($1,$2,$3::jsonb,$4::uuid,$5)', ['Title', 'Content', '{}', actor, email])).rejects.toMatchObject({ code: '42501' });
    await db.exec('RESET ROLE');
  });
});

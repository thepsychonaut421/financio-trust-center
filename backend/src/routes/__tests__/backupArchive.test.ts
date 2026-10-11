import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

it('requires restored draft/published files while allowing archive metadata whose bytes were removed', async () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/financio-backup.py'), 'utf8');
  const sql = script.match(/paths = run\(psql, input=b"([^"]+)"/)?.[1];
  expect(sql).toBeDefined();
  const database = new PGlite();
  try {
    await database.exec(`CREATE TABLE public.documents (file_url text, status text);
      INSERT INTO public.documents VALUES ('review/draft.pdf', 'draft'), ('published/current.pdf', 'published'), ('removed/old.pdf', 'archived');`);
    const result = await database.query(sql!);
    expect(result.rows).toEqual([{ file_url: 'review/draft.pdf' }, { file_url: 'published/current.pdf' }]);
  } finally { await database.close(); }
});

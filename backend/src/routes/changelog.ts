import express, { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../server';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { collectDraft, EvidenceError, sourceRepository } from '../services/changelogEvidence';

const router = express.Router();
router.use(requireAdmin);
const idSchema = z.string().uuid();
const generateSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict();
const editSchema = z.object({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20000) }).strict();
const reviewSchema = z.object({ revision: z.number().int().positive(), decision: z.enum(['publish', 'reject']), note: z.string().trim().min(1).max(2000), confirm: z.literal(true) }).strict();
function fail(res: Response, error: unknown) {
  if (error instanceof EvidenceError) return res.status(error.status).json({ error: error.message });
  const code = (error as { code?: string })?.code;
  const status = code === 'PT409' || code === '40001' ? 409 : code === 'P0002' ? 404 : code === '42501' ? 403 : 503;
  return res.status(status).json({ error: status === 409 ? 'Draft changed or already reviewed; reload before acting' : status === 404 ? 'Draft not found' : 'Changelog operation unavailable' });
}
router.get('/config', (_req, res) => {
  try {
    res.json({ repository: sourceRepository(), github: process.env.TRUST_CENTER_GITHUB_TOKEN ? 'configured' : 'not_configured', ai: 'not_configured', deploy: 'not_configured', securityCloud: 'not_configured' });
  } catch (error) { fail(res, error); }
});
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('changelog_drafts').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data);
  } catch (error) { fail(res, error); }
});
// Only authenticated administrators can generate; collectDraft performs read-only source calls.
const inFlight = new Set<string>();
router.post('/generate', async (req: AuthRequest, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid generation request' });
  const actor = req.admin!;
  if (inFlight.has(actor.id)) return res.status(429).json({ error: 'Generation already in progress' });
  inFlight.add(actor.id);
  try {
    const draft = await collectDraft(parsed.data.sha);
    const { data, error } = await supabase.rpc('create_changelog_draft', {
      p_title: draft.title, p_content: draft.content, p_evidence: draft.evidence, p_actor_id: actor.id, p_actor_email: actor.email,
    });
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) { fail(res, error); } finally { inFlight.delete(actor.id); }
});
router.get('/:id/history', async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid draft id' });
  try {
    const { data, error } = await supabase.from('changelog_review_events').select('action,actor_email,revision,title,content,note,created_at').eq('draft_id', req.params.id).order('id', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (error) { fail(res, error); }
});
router.patch('/:id', async (req: AuthRequest, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success || !idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid draft edit' });
  try {
    const { data, error } = await supabase.rpc('review_changelog_draft', {
      p_id: req.params.id, p_revision: parsed.data.revision, p_action: 'edit', p_title: parsed.data.title, p_content: parsed.data.content,
      p_note: 'Draft edited', p_actor_id: req.admin!.id, p_actor_email: req.admin!.email,
    });
    if (error) throw error;
    res.json(data);
  } catch (error) { fail(res, error); }
});
router.post('/:id/review', async (req: AuthRequest, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success || !idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Explicit confirmation and a review note are required' });
  try {
    const { data, error } = await supabase.rpc('review_changelog_draft', {
      p_id: req.params.id, p_revision: parsed.data.revision, p_action: parsed.data.decision, p_title: null, p_content: null,
      p_note: parsed.data.note, p_actor_id: req.admin!.id, p_actor_email: req.admin!.email,
    });
    if (error) throw error;
    res.json(data);
  } catch (error) { fail(res, error); }
});
export default router;

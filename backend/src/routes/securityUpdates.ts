import express from 'express';
import { supabase } from '../server';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { logActivity } from '../utils/activityLogger';
import { z } from 'zod';

const router = express.Router();
const editable = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20000),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
  published_at: z.string().datetime().nullable().optional(),
}).strict();

// Get security updates (public or admin)
// Use ?include_unpublished=true for admin to see all updates
router.get('/', (req, res, next) => {
  if (req.query.include_unpublished === 'true') return requireAdmin(req, res, next);
  next();
}, async (req, res) => {
  try {
    const includeUnpublished = req.query.include_unpublished === 'true';
    const columns: string = includeUnpublished ? '*' : 'id,title,content,severity,published_at,created_at,updated_at,source_draft_id';

    let query = supabase
      .from('security_updates')
      .select(columns);

    if (!includeUnpublished) {
      // Public view: only published updates
      query = query
        .not('published_at', 'is', null)
        .lte('published_at', new Date().toISOString());
    }

    // Order by published_at for public, created_at for admin
    const { data, error } = await query.order(
      includeUnpublished ? 'created_at' : 'published_at',
      { ascending: false }
    );

    if (error) throw error;
    const updates = (data || []) as unknown as Array<Record<string, unknown>>;

    // The reviewed editor and preview use plain text. Expose only the format,
    // never the private draft identifier or its evidence, to the public client.
    res.json(includeUnpublished ? data : updates.map(update => ({
      id: update.id, title: update.title, content: update.content, severity: update.severity,
      published_at: update.published_at, created_at: update.created_at, updated_at: update.updated_at,
      content_format: update.source_draft_id ? 'plain_text' : 'html',
    })));
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create security update (admin only)
router.post('/', requireAdmin, async (req: AuthRequest, res) => {
  const parsed = editable.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid security update' });
  try {
    const { data, error } = await supabase
      .from('security_updates')
      .insert({
        ...parsed.data,
        published_at: parsed.data.published_at === undefined ? new Date().toISOString() : parsed.data.published_at,
      })
      .select()
      .single();

    if (error) throw error;

    // Log security update creation
    await logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      actionType: 'create',
      entityType: 'security_update',
      entityId: data.id,
      entityName: data.title,
      newValue: data,
      description: `Created security update: ${data.title}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(data);
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update security update (admin only)
router.patch('/:id', requireAdmin, async (req: AuthRequest, res) => {
  const parsed = editable.partial().safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'Invalid security update edit' });
  try {
    // Get existing data for comparison
    const { data: existing, error: readError } = await supabase
      .from('security_updates')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (readError || !existing) return res.status(404).json({ error: 'Security update not found' });
    if (existing.source_draft_id) return res.status(409).json({ error: 'Reviewed changelog entries are immutable; publish a correction instead' });

    const { data, error } = await supabase
      .from('security_updates')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Log security update edit
    await logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      actionType: 'update',
      entityType: 'security_update',
      entityId: data.id,
      entityName: data.title,
      oldValue: existing,
      newValue: data,
      description: `Updated security update: ${data.title}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(data);
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete security update (admin only)
router.delete('/:id', requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Get existing data for logging
    const { data: existing, error: readError } = await supabase
      .from('security_updates')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (readError || !existing) return res.status(404).json({ error: 'Security update not found' });
    if (existing.source_draft_id) return res.status(409).json({ error: 'Reviewed changelog entries are immutable; publish a correction instead' });

    const { error } = await supabase
      .from('security_updates')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    // Log security update deletion
    await logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      actionType: 'delete',
      entityType: 'security_update',
      entityId: req.params.id,
      entityName: existing?.title || 'Unknown',
      oldValue: existing,
      description: `Deleted security update: ${existing?.title || 'Unknown'}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Security update deleted successfully' });
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

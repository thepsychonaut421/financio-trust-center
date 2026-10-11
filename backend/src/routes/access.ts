import express from 'express';
import { supabase } from '../server';
import fs from 'fs';
import { logActivity } from '../utils/activityLogger';
import { resolveUploadPath } from '../utils/safePath';
import { sanitizeUploadFileName } from '../middleware/upload';
import { accessRequestError, currentNdaUrl, isAvailableDocument } from '../utils/documentAccess';

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

async function findRequest(token: string) {
  const { data, error } = await supabase.from('document_requests')
    .select('*').eq('magic_link_token', token).maybeSingle();
  if (error) throw error;
  return data;
}

router.get('/:token', async (req, res) => {
  try {
    const request = await findRequest(req.params.token);
    if (!request) return res.status(404).json({ error: 'Invalid or expired link' });
    const denied = await accessRequestError(request);
    if (denied) return res.status(403).json({ error: denied });
    const { data, error } = await supabase.from('documents')
      .select('id,title,description,file_name,file_type,file_size,access_level,requires_nda,status,is_current_version,expires_at')
      .in('id', request.document_ids || []);
    if (error) throw error;
    const documents = (data || []).filter(isAvailableDocument);
    if (!request.magic_link_used_at) {
      const { error: updateError } = await supabase.from('document_requests')
        .update({ magic_link_used_at: new Date().toISOString() }).eq('id', request.id);
      if (updateError) throw updateError;
    }
    res.json({ request: { id: request.id, requester_name: request.requester_name, documents } });
  } catch (error) {
    console.error('Access lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:token/download/:document_id', async (req, res) => {
  try {
    const request = await findRequest(req.params.token);
    if (!request) return res.status(404).json({ error: 'Invalid or expired link' });
    const denied = await accessRequestError(request);
    if (denied) return res.status(403).json({ error: denied });
    if (!Array.isArray(request.document_ids) || !request.document_ids.includes(req.params.document_id)) {
      return res.status(403).json({ error: 'Document not included in this request' });
    }
    const { data: document, error } = await supabase.from('documents')
      .select('*').eq('id', req.params.document_id).maybeSingle();
    if (error) throw error;
    if (!document || !isAvailableDocument(document)) return res.status(404).json({ error: 'Document not found' });
    if (document.requires_nda) {
      const ndaUrl = await currentNdaUrl();
      if (!ndaUrl) return res.status(409).json({ error: 'NDA_UNAVAILABLE' });
      if (!request.nda_accepted_at || request.accepted_nda_url !== ndaUrl) {
        return res.status(403).json({ error: 'NDA_REQUIRED', nda_url: ndaUrl });
      }
    }
    const filePath = resolveUploadPath(document.file_url);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on server' });
    await logActivity({
      adminId: 'public', adminEmail: request.requester_email,
      actionType: 'document_download', entityType: 'document', entityId: document.id,
      entityName: document.file_name,
      description: `Document downloaded by ${request.requester_email}: ${document.file_name}`,
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeUploadFileName(document.file_name).replace(/"/g, '')}"`);
    res.setHeader('Content-Type', document.file_type || 'application/octet-stream');
    return res.sendFile(filePath);
  } catch (error) {
    console.error('Document access failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:token/accept-nda', async (req, res) => {
  try {
    const request = await findRequest(req.params.token);
    if (!request) return res.status(404).json({ error: 'Invalid or expired link' });
    const denied = await accessRequestError(request);
    if (denied) return res.status(403).json({ error: denied });
    const ndaUrl = await currentNdaUrl();
    if (!ndaUrl) return res.status(409).json({ error: 'NDA_UNAVAILABLE' });
    if (req.body.nda_accepted !== true || req.body.nda_url !== ndaUrl) {
      return res.status(400).json({ error: 'Explicit acceptance of the current NDA is required' });
    }
    const { error: insertError } = await supabase.from('nda_acceptances').insert({
      email: request.requester_email, organization_id: request.organization_id,
      request_id: request.id, nda_url: ndaUrl,
      ip_address: req.ip, user_agent: req.headers['user-agent'],
    });
    if (insertError) throw insertError;
    const { error: updateError } = await supabase.from('document_requests')
      .update({ nda_accepted_at: new Date().toISOString(), accepted_nda_url: ndaUrl })
      .eq('id', request.id).eq('magic_link_token', req.params.token);
    if (updateError) throw updateError;
    res.json({ message: 'NDA accepted successfully' });
  } catch (error) {
    console.error('NDA acceptance failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

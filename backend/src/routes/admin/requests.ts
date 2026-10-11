import express from 'express';
import { supabase } from '../../server';
import { dispatchWebhook } from '../../services/webhookDispatcher';
import { requireAdmin, AuthRequest } from '../../middleware/auth';
import { generateMagicLinkToken, getMagicLinkExpiration } from '../../utils/magicLink';
import { sendMagicLinkEmail, sendRejectionEmail } from '../../utils/email';
import { logActivity } from '../../utils/activityLogger';
import { handleError } from '../../utils/errorHandler';
import { requestedPublishedDocuments, currentNdaUrl } from '../../utils/documentAccess';

const router = express.Router();

// Get all document requests (admin only)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status, organization_id } = req.query;

    // First get document requests (without joining documents - no FK relationship)
    let query = supabase
      .from('document_requests')
      .select('*, organizations(id, name, email_domain)')
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    if (organization_id) {
      query = query.eq('organization_id', organization_id);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    // Batch-fetch all referenced documents in a single query
    const allDocIds = [...new Set((data || []).flatMap(r => r.document_ids || []))];
    let docMap = new Map<string, { id: string; title: string }>();
    if (allDocIds.length > 0) {
      const { data: allDocs } = await supabase
        .from('documents')
        .select('id, title')
        .in('id', allDocIds);
      docMap = new Map((allDocs || []).map(d => [d.id, d]));
    }

    const requestsWithDocs = (data || []).map(request => ({
      ...request,
      documents: (request.document_ids || [])
        .map((id: string) => docMap.get(id))
        .filter(Boolean),
    }));

    res.json(requestsWithDocs);
  } catch (error: any) {
    handleError(res, error, 'Document requests route error');
  }
});

// Get request details with history (admin only)
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const { data: request, error } = await supabase
      .from('document_requests')
      .select('*, organizations(id, name, email_domain)')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // Fetch document details
    let documents: { id: string; title: string }[] = [];
    if (request.document_ids && request.document_ids.length > 0) {
      const { data: docs } = await supabase
        .from('documents')
        .select('id, title')
        .in('id', request.document_ids);
      documents = docs || [];
    }

    // Get request history from same email
    const { data: history } = await supabase
      .from('document_requests')
      .select('id, status, created_at, document_ids')
      .eq('requester_email', request.requester_email)
      .neq('id', request.id)
      .order('created_at', { ascending: false })
      .limit(10);

    res.json({
      ...request,
      documents,
      history: history || [],
    });
  } catch (error: any) {
    handleError(res, error, 'Get request details error');
  }
});

class ApprovalError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

async function approveRequest(id: string, req: AuthRequest, expirationDays?: number | null, notes?: string) {
  if (expirationDays != null && (!Number.isInteger(expirationDays) || expirationDays < 1 || expirationDays > 365)) {
    throw new ApprovalError(400, 'Expiration must be between 1 and 365 whole days');
  }
  const { data: request, error } = await supabase.from('document_requests')
    .select('*, organizations(*)').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!request) throw new ApprovalError(404, 'Request not found');
  if (request.status !== 'pending') throw new ApprovalError(409, 'Only pending requests can be approved');
  if (request.organization_id && (!request.organizations || request.organizations.status === 'no_access'
    || request.organizations.is_active === false)) {
    throw new ApprovalError(403, 'Organization access is blocked or inactive');
  }
  const documents = await requestedPublishedDocuments(request.document_ids || []);
  if (!documents?.length) throw new ApprovalError(409, 'Requested documents are unavailable');
  if (documents.some(doc => doc.requires_nda) && !await currentNdaUrl()) {
    throw new ApprovalError(409, 'NDA_UNAVAILABLE');
  }
  const token = generateMagicLinkToken();
  const expiration = getMagicLinkExpiration(Math.min(expirationDays || 7, 7));
  const accessExpiresAt = expirationDays ? getMagicLinkExpiration(expirationDays).toISOString() : null;
  const { data: updatedRequest, error: updateError } = await supabase.from('document_requests')
    .update({ status: 'approved', magic_link_token: token, magic_link_expires_at: expiration.toISOString(),
      reviewed_by: req.admin!.id, reviewed_at: new Date().toISOString(), admin_notes: notes || null,
      access_expires_at: accessExpiresAt, expiration_days: expirationDays || null,
      nda_accepted_at: null, accepted_nda_url: null,
    }).eq('id', id).eq('status', 'pending').select().maybeSingle();
  if (updateError) throw updateError;
  if (!updatedRequest) throw new ApprovalError(409, 'Request already reviewed');
  let emailSent = false;
  try {
    await sendMagicLinkEmail({ requesterName: request.requester_name, requesterEmail: request.requester_email,
      documents: documents.map(doc => ({ id: doc.id, title: doc.title })), magicLinkToken: token,
      magicLinkUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/access/${token}`,
      expirationDate: expiration.toISOString(),
    });
    emailSent = true;
  } catch { console.error('Approval email delivery request failed'); }
  await logActivity({ adminId: req.admin!.id, adminEmail: req.admin!.email,
    actionType: 'approval', entityType: 'request', entityId: id,
    entityName: `Request from ${request.requester_name}`, oldValue: { status: 'pending' },
    newValue: { status: 'approved' }, description: `Approved document request for: ${documents.map(doc => doc.title).join(', ')}`,
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  dispatchWebhook('request.approved', updatedRequest);
  return { ...updatedRequest, emailSent, ...(!emailSent ? { emailError: 'Approval saved, but email delivery could not be requested.' } : {}) };
}

router.patch('/:id/approve', requireAdmin, async (req: AuthRequest, res) => {
  try {
    res.json(await approveRequest(req.params.id, req, req.body.expiration_days, req.body.admin_notes));
  } catch (error) {
    if (error instanceof ApprovalError) return res.status(error.statusCode).json({ error: error.message });
    handleError(res, error, 'Approve request error');
  }
});

// Revocation takes effect on both the access page and every subsequent download.
router.patch('/:id/revoke', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { data, error } = await supabase.from('document_requests')
      .update({ status: 'denied', magic_link_token: null, magic_link_expires_at: new Date().toISOString(),
        reviewed_by: req.admin!.id, reviewed_at: new Date().toISOString(),
      }).eq('id', req.params.id).in('status', ['approved', 'auto_approved']).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'No approved request to revoke' });
    await logActivity({ adminId: req.admin!.id, adminEmail: req.admin!.email, actionType: 'update',
      entityType: 'request', entityId: data.id, description: 'Revoked document access',
      newValue: { status: 'denied' }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.json(data);
  } catch (error) { handleError(res, error, 'Revoke request error'); }
});

// Deny document request (admin only)
router.patch('/:id/deny', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { admin_notes, reason } = req.body;

    const { data: request, error } = await supabase
      .from('document_requests')
      .update({
        status: 'denied',
        reviewed_by: req.admin!.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: admin_notes || null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Send rejection email
    await sendRejectionEmail(request.requester_email, request.requester_name, reason);

    // Log the denial
    await logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      actionType: 'denial',
      entityType: 'request',
      entityId: id,
      entityName: `Request from ${request.requester_name}`,
      oldValue: { status: 'pending' },
      newValue: { status: 'denied' },
      description: `Denied document request${reason ? `: ${reason}` : ''}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Dispatch webhook
    dispatchWebhook('request.denied', { ...request, status: 'denied', admin_notes: admin_notes });

    res.json(request);
  } catch (error: any) {
    handleError(res, error, 'Deny request error');
  }
});

// Batch decisions use the same checks and delivery path as a single approval.
router.post('/batch-approve', requireAdmin, async (req: AuthRequest, res) => {
  const ids = req.body.request_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || ids.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: 'Select between 1 and 20 request IDs' });
  }
  try {
    const results = [];
    for (const id of new Set<string>(ids)) {
      try {
        const approved = await approveRequest(id, req);
        results.push({ id, status: 'approved', emailSent: approved.emailSent });
      } catch (error) {
        if (!(error instanceof ApprovalError)) throw error;
        results.push({ id, status: 'skipped', error: error.message });
      }
    }
    res.json({ success: true, results });
  } catch (error) { handleError(res, error, 'Batch approve error'); }
});

// Batch deny requests (admin only)
router.post('/batch-deny', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { request_ids, reason } = req.body;

    if (!Array.isArray(request_ids) || request_ids.length === 0) {
      return res.status(400).json({ error: 'request_ids array is required' });
    }

    const results = [];

    for (const requestId of request_ids) {
      const { data: request } = await supabase
        .from('document_requests')
        .select('requester_name, requester_email, status')
        .eq('id', requestId)
        .single();

      if (request && request.status === 'pending') {
        await supabase
          .from('document_requests')
          .update({
            status: 'denied',
            reviewed_by: req.admin!.id,
            reviewed_at: new Date().toISOString(),
            admin_notes: reason || null,
          })
          .eq('id', requestId);

        // Send rejection email
        try {
          await sendRejectionEmail(request.requester_email, request.requester_name, reason);
        } catch (emailErr) {
          console.error(`Failed to send rejection email to ${request.requester_email}`);
        }

        results.push({ id: requestId, status: 'denied' });
      }
    }

    // Log bulk action
    await logActivity({
      adminId: req.admin!.id,
      adminEmail: req.admin!.email,
      actionType: 'bulk_denial',
      entityType: 'request',
      entityId: request_ids.join(','),
      entityName: `${results.length} requests`,
      description: `Bulk denied ${results.length} document requests${reason ? `: ${reason}` : ''}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    for (const r of results) {
      dispatchWebhook('request.denied', { id: r.id, status: 'denied' });
    }

    res.json({ success: true, results });
  } catch (error: any) {
    handleError(res, error, 'Batch deny error');
  }
});

export default router;

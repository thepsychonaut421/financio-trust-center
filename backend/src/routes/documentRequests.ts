import express from 'express';
import { supabase } from '../server';
import { dispatchWebhook } from '../services/webhookDispatcher';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { extractEmailDomain, isPersonalEmailDomain, getOrCreateOrganization, checkOrganizationAccess } from '../utils/organization';
import { emailRateLimit } from '../middleware/rateLimit';
import { validateEmailAddress } from '../utils/emailValidation';
import { notifyAdminsOfNewRequest } from '../utils/adminNotifications';
import { requestedPublishedDocuments, currentNdaUrl } from '../utils/documentAccess';

const router = express.Router();

// Submit document request (public, no auth)
router.post('/', emailRateLimit, async (req, res) => {
  try {
    const { name, email, company, document_ids, reason } = req.body;

    if (!name || !email || !company || !document_ids || !Array.isArray(document_ids) || document_ids.length === 0) {
      return res.status(400).json({ error: 'Name, email, company, and at least one document are required' });
    }

    const trimmedName = String(name).trim();
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedCompany = String(company).trim();
    const trimmedReason = reason ? String(reason).trim() : null;

    if (trimmedName.length < 2 || trimmedName.length > 120) {
      return res.status(400).json({ error: 'Name must be between 2 and 120 characters' });
    }

    if (!validateEmailAddress(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (trimmedCompany.length < 2 || trimmedCompany.length > 120) {
      return res.status(400).json({ error: 'Company must be between 2 and 120 characters' });
    }

    if (trimmedReason && trimmedReason.length > 2000) {
      return res.status(400).json({ error: 'Reason must be 2000 characters or less' });
    }

    if (document_ids.length > 20) {
      return res.status(400).json({ error: 'A maximum of 20 documents can be requested at once' });
    }

    const normalizedDocumentIds = Array.from(
      new Set(
        document_ids
          .filter((id: unknown) => typeof id === 'string')
          .map((id: string) => id.trim())
          .filter((id: string) => id.length > 0)
      )
    );

    if (normalizedDocumentIds.length === 0) {
      return res.status(400).json({ error: 'At least one valid document ID is required' });
    }

    if (normalizedDocumentIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }
    const documents = await requestedPublishedDocuments(normalizedDocumentIds);
    if (!documents) return res.status(400).json({ error: 'One or more documents are unavailable' });
    if (documents.some(doc => doc.requires_nda) && !await currentNdaUrl()) {
      return res.status(409).json({ error: 'NDA_UNAVAILABLE' });
    }

    // Extract email domain
    const emailDomain = extractEmailDomain(trimmedEmail);
    if (!emailDomain) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Get or create organization
    let organizationId: string | null = null;
    if (!isPersonalEmailDomain(emailDomain)) {
      const org = await getOrCreateOrganization(emailDomain, trimmedCompany);
      organizationId = org.id;
    }

    // Financio decisions are manual. A matching email domain alone never
    // grants access, including for an organization marked whitelisted.
    if (organizationId) {
      const accessCheck = await checkOrganizationAccess(organizationId);
      if (!accessCheck.hasAccess) return res.status(403).json({ error: 'Access denied', status: accessCheck.status });
    }
    const { data: pendingRequest, error: pendingError } = await supabase
      .from('document_requests').insert({
        requester_name: trimmedName, requester_email: trimmedEmail,
        requester_company: trimmedCompany, organization_id: organizationId,
        document_ids: normalizedDocumentIds, request_reason: trimmedReason, status: 'pending',
      }).select().single();
    if (pendingError) throw pendingError;
    dispatchWebhook('request.created', pendingRequest);
    notifyAdminsOfNewRequest({
      requester_name: trimmedName, requester_email: trimmedEmail,
      requester_company: trimmedCompany, document_count: normalizedDocumentIds.length,
    }).catch(() => console.error('Failed to send admin notification'));
    res.json({ success: true, auto_approved: false, message: 'Your request has been submitted and is under review.' });
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get request history by email (admin only)
router.get('/history/:email', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('document_requests')
      .select('*, documents(*)')
      .eq('requester_email', req.params.email)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

-- Acceptance belongs to the approved request, rather than an unauthenticated
-- email address. Existing requests must accept the current approved agreement.
ALTER TABLE public.document_requests
  ADD COLUMN IF NOT EXISTS nda_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_nda_url TEXT;

ALTER TABLE public.nda_acceptances
  ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES public.document_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS nda_url TEXT;

-- Keep an unapproved upstream sample out of the active request flow.
UPDATE public.trust_center_settings SET nda_url = NULL
WHERE nda_url = '/nda-sample.html';

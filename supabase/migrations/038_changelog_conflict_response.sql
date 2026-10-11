-- A stale review is a permanent business conflict, not a retryable database
-- serialization failure. PT409 tells PostgREST to return HTTP 409 directly.
-- CREATE OR REPLACE preserves the existing restricted function privileges.
CREATE OR REPLACE FUNCTION public.review_changelog_draft(p_id uuid, p_revision integer, p_action text, p_title text, p_content text,
  p_note text, p_actor_id uuid, p_actor_email text)
RETURNS public.changelog_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.changelog_drafts; event_action text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE id = p_actor_id AND email = p_actor_email) THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.changelog_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002'; END IF;
  IF d.state <> 'draft' OR d.revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'Draft changed or already reviewed; reload before acting' USING ERRCODE = 'PT409';
  END IF;
  IF p_action = 'edit' THEN
    d.title := p_title; d.content := p_content; event_action := 'edited';
  ELSIF p_action IN ('publish', 'reject') THEN
    IF p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'A review note is required' USING ERRCODE = '22023';
    END IF;
    d.state := CASE WHEN p_action = 'publish' THEN 'published' ELSE 'rejected' END;
    event_action := d.state;
  ELSE RAISE EXCEPTION 'Invalid action' USING ERRCODE = '22023';
  END IF;
  UPDATE public.changelog_drafts SET title = d.title, content = d.content, state = d.state,
    revision = revision + 1, updated_at = now() WHERE id = d.id RETURNING * INTO d;
  INSERT INTO public.changelog_review_events(draft_id, action, actor_id, actor_email, revision, title, content, note)
    VALUES (d.id, event_action, p_actor_id, p_actor_email, d.revision, d.title, d.content, coalesce(p_note, 'Draft edited'));
  IF p_action = 'publish' THEN
    INSERT INTO public.security_updates(title, content, published_at, source_draft_id)
      VALUES (d.title, d.content, now(), d.id);
  END IF;
  RETURN d;
END $$;


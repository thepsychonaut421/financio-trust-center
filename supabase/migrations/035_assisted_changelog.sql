-- Internal evidence and review never belong in the public security_updates table.
CREATE TABLE public.changelog_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.changelog_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES public.changelog_drafts(id),
  action text NOT NULL CHECK (action IN ('generated', 'edited', 'published', 'rejected')),
  actor_id uuid NOT NULL,
  actor_email text NOT NULL,
  revision integer NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.security_updates ADD COLUMN source_draft_id uuid UNIQUE REFERENCES public.changelog_drafts(id);
ALTER TABLE public.changelog_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.changelog_review_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.changelog_drafts, public.changelog_review_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.changelog_review_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.changelog_drafts, public.changelog_review_events TO service_role;

-- Mutations are restricted to atomic RPCs, including mandatory audit writes.
CREATE FUNCTION public.create_changelog_draft(p_title text, p_content text, p_evidence jsonb, p_actor_id uuid, p_actor_email text)
RETURNS public.changelog_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.changelog_drafts;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE id = p_actor_id AND email = p_actor_email) THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.changelog_drafts(title, content, evidence) VALUES (p_title, p_content, p_evidence) RETURNING * INTO d;
  INSERT INTO public.changelog_review_events(draft_id, action, actor_id, actor_email, revision, title, content, note)
    VALUES (d.id, 'generated', p_actor_id, p_actor_email, d.revision, d.title, d.content, 'Generated from evidence; not published');
  RETURN d;
END $$;

CREATE FUNCTION public.review_changelog_draft(p_id uuid, p_revision integer, p_action text, p_title text, p_content text,
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
    RAISE EXCEPTION 'Draft changed or already reviewed; reload before acting' USING ERRCODE = '40001';
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
REVOKE ALL ON FUNCTION public.create_changelog_draft(text,text,jsonb,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_changelog_draft(uuid,integer,text,text,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_changelog_draft(text,text,jsonb,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_changelog_draft(uuid,integer,text,text,text,text,uuid,text) TO service_role;

CREATE FUNCTION public.preserve_changelog_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published changelog entries and review history are immutable; publish a correction instead' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER changelog_events_immutable BEFORE UPDATE OR DELETE ON public.changelog_review_events
  FOR EACH ROW EXECUTE FUNCTION public.preserve_changelog_history();
CREATE TRIGGER changelog_publication_immutable BEFORE UPDATE OR DELETE ON public.security_updates
  FOR EACH ROW WHEN (OLD.source_draft_id IS NOT NULL) EXECUTE FUNCTION public.preserve_changelog_history();

-- Protect direct browser/table writes too, including attaching a draft to a legacy entry.
CREATE FUNCTION public.require_reviewed_changelog_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.changelog_drafts d JOIN public.changelog_review_events e
      ON e.draft_id = d.id AND e.revision = d.revision AND e.action = 'published'
    WHERE d.id = NEW.source_draft_id AND d.state = 'published'
      AND d.title = NEW.title AND d.content = NEW.content AND NEW.published_at IS NOT NULL
      AND e.title = d.title AND e.content = d.content
  ) THEN
    RAISE EXCEPTION 'Publish the reviewed draft through its approval workflow' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER changelog_publication_requires_review BEFORE INSERT OR UPDATE ON public.security_updates
  FOR EACH ROW WHEN (NEW.source_draft_id IS NOT NULL) EXECUTE FUNCTION public.require_reviewed_changelog_publication();

-- Migration005's SECURITY DEFINER helpers are privileged server operations.
-- Granting service_role does not remove PostgreSQL's default PUBLIC execution.
REVOKE ALL ON FUNCTION public.create_user_with_password(text, text, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_user_password(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_all_users()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_user_with_password(text, text, text, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_user_password(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_all_users()
  TO service_role;

-- The public HTTP settings API projects safe branding fields. Direct Supabase
-- reads must not expose notification recipients or administrator preferences.
REVOKE SELECT ON public.trust_center_settings FROM anon;
DROP POLICY "Anyone can view trust center settings" ON public.trust_center_settings;
CREATE POLICY "Only admins can view trust center settings"
  ON public.trust_center_settings FOR SELECT
  USING (auth.uid() IN (SELECT id FROM public.admin_users));

-- Browser roles may read published copy, not its private review linkage.
-- Administrators use the backend API for the linked draft and review history.
REVOKE SELECT ON public.security_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, title, content, severity, published_at, created_at, updated_at)
  ON public.security_updates TO anon, authenticated;

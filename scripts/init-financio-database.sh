#!/usr/bin/env bash
# Fresh native Supabase project only. Credentials stay in standard PG* bindings.
set -euo pipefail

if [[ "${TRUST_CENTER_DATABASE_PURPOSE:-}" != "financio-trust-center" ]]; then
  printf '%s\n' 'Set TRUST_CENTER_DATABASE_PURPOSE=financio-trust-center for the dedicated fresh project.' >&2
  exit 1
fi
: "${PGHOST:?Configure the dedicated Supabase database PGHOST}"
: "${PGDATABASE:?Configure the dedicated Supabase PGDATABASE}"
: "${PGUSER:?Configure the dedicated Supabase migration PGUSER}"
command -v psql >/dev/null || { printf '%s\n' 'psql is required.' >&2; exit 1; }

# Hosted Supabase supplies its own auth/storage schema and functions. Never apply
# upstream000's development auth replacement or018's unverified public claims.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
migration_dir="${script_dir}/../supabase/migrations"
transaction_file="$(mktemp)"
trap 'rm -f -- "$transaction_file"' EXIT
chmod 600 "$transaction_file"

cat > "$transaction_file" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('financio-trust-center-initialization'));
SET LOCAL search_path = public, extensions;
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL OR to_regclass('storage.objects') IS NULL
     OR to_regclass('storage.buckets') IS NULL OR to_regprocedure('auth.uid()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'Use a fresh dedicated native Supabase project; auth/storage prerequisites are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  ) THEN
    RAISE EXCEPTION 'Fresh database required: public application tables or views already exist; nothing was changed';
  END IF;
END $$;
SQL

for migration in "$migration_dir"/[0-9][0-9][0-9]_*.sql; do
  migration_name="${migration##*/}"
  case "$migration_name" in
    000_auth_schema.sql|018_seed_plaid_categories.sql) continue ;;
  esac
  cat -- "$migration" >> "$transaction_file"
  printf '\n' >> "$transaction_file"
done
printf '\nCOMMIT;\n' >> "$transaction_file"

# -X ignores .psqlrc; a failure rolls back the entire fresh-project initialization.
# Do not add a connection URL or password argument. psql uses PG* or .pgpass.
PGSSLMODE="${PGSSLMODE:-verify-full}" psql -X --quiet --set=ON_ERROR_STOP=1 --file="$transaction_file"
printf '%s\n' 'Initialized the dedicated Trust Center database; demo claims and development auth bootstrap were skipped.'

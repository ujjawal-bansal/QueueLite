-- schema.sql grants to Supabase's API roles. A plain Postgres has neither,
-- so create them before 01-schema.sql runs. The Java API connects as the
-- owner and never uses them.
create role anon nologin;
create role authenticated nologin;

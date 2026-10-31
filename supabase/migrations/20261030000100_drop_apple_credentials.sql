-- TM-02: Apple tokens are no longer stored. delete-account receives the one-time
-- authorization code from the fresh Sign in with Apple, exchanges and revokes it at once.
-- The table was never written to (native Sign in with Apple gives the server no refresh token).
-- Dropping the table also drops its trigger, RLS setting and grants.
drop table if exists public.apple_credentials;

# Threat model

Status: draft skeleton. The security workstream fills this in during Phase 0; Gate 1 requires it to be published.

## System summary

Expo iPhone app with native Swift targets, a Supabase backend (Postgres with row-level security, edge functions, scheduled jobs), the Claude API for task extraction, and Apple Push Notification service for the morning brief and evening check-in. Phase 1 adds Gmail (OAuth) and share-sheet capture.

## Assets

Voice transcripts, task contents, auth tokens (Supabase session, Apple refresh token), API keys, and in Phase 1 Gmail tokens and message snippets.

## Trust boundaries

1. Phone ↔ Supabase (user JWT, row-level security)
2. Edge functions ↔ Claude API (transcript in, schema-checked JSON out)
3. Scheduled jobs ↔ APNs (counts and IDs only in payloads)
4. Locked phone ↔ app-group summary (readable after first unlock)
5. Phase 1: Supabase ↔ Gmail (OAuth, untrusted message content)

## Threats and controls

To be written per boundary using STRIDE. Source of truth for accepted controls: the Security requirements section of the product requirements doc and the Phase 0 security review (S-01 to S-13).

## Tests that prove the controls

- Cross-user tests: every endpoint, RPC and realtime channel called with another user's IDs
- Prompt-injection test set for extraction
- Secret scanning and static analysis in CI

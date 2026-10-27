# Tasklings

Voice-first task app for brains that drop things: speak a note, get a calm daily plan, and earn rewards for finishing. Built in public, with a published threat model.

> Status: Phase 0 (MVP) in progress. Not yet usable.

## What it does

- **Capture:** hold the mic (in the app, the lock screen, the Action Button or Siri) and ramble; one note becomes several clean tasks.
- **Plan:** one Today list grouped into quick wins, errands and bigger things, with a single "Start here" task.
- **Brief and check-in:** a morning count of what's on, and an evening card stack to close out the day.
- **Carry forward:** unfinished tasks roll over on their own until they're done or dropped.

## Repository layout

| Folder | What lives there | Owner workstream |
| --- | --- | --- |
| `app/` | Expo (React Native, TypeScript) app | Mobile app |
| `app/targets/` | Native Swift targets: widgets, App Intents, Live Activity, extensions | Native iOS |
| `supabase/` | Postgres migrations, RLS policies, RPCs, edge functions, scheduled jobs | Backend |
| `ai/` | Extraction prompts, output schemas, eval harness | AI pipeline |
| `docs/` | Threat model, security notes, decisions | Security |

The workstreams meet only at the API contracts and data model in the product requirements doc.

## How work lands

- One branch and one pull request per story, titled with its story ID, for example `US-03: extract tasks from a note`.
- CI must pass and the owner must approve before anything merges to `main`.
- Contracts change only after the requirements doc is updated.

## Security

- No secrets in this repo, ever. Keys live in Supabase secrets and GitHub Actions secrets.
- No real personal data in this repo, including test sets: notes used for evals are synthetic.
- Report a vulnerability: see [SECURITY.md](SECURITY.md).
- Threat model: [docs/threat-model.md](docs/threat-model.md).

## License

No license yet: all rights reserved. You're welcome to read the code; please don't reuse it without asking.

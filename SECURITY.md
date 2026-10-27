# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button on the Security tab of this repository. Don't open a public issue.

You'll get an acknowledgement within 7 days. This is a personal project, so there is no bug bounty.

## Scope

- The code in this repository: the app, the Supabase backend and the AI pipeline.
- Out of scope: third-party services (Apple, Supabase, Anthropic, Expo, Google) except where this project configures them.

## Ground rules for this repo

- Secrets never go in the repository. Push protection and gitleaks block common key formats; rotate any key that slips through, don't just delete the commit.
- Test data is synthetic. No real voice notes, task lists, emails or messages.

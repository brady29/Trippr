# Security

Trippr holds a small group's travel plans, including booking references, so problems that could expose them matter.

## Reporting a problem

Please report it privately with the **Report a vulnerability** button on this repository's Security tab, not in a public issue. Include what you found, how to reproduce it, and what it could expose. You'll get a reply within a week.

## What's in scope

- The API (`apps/api`) and web app (`apps/web`), including the live deployment linked in the README.
- Ways to read another trip's data, read booking references as a viewer or the demo account, or get the inbox webhook to act on a trip without its secret.

Please don't run automated scanners or load tests against the live deployment, and don't access other people's trips beyond what you need to show the problem.

## How secrets are handled

- No secrets are committed. CI scans every push with gitleaks.
- Production secrets live in Google Secret Manager. GitHub Actions reaches Google Cloud through workload identity federation, so no service-account key exists.
- Booking references and seats are only returned to a trip's owner and editors.

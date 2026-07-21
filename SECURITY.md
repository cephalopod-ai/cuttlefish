# Security Policy

## Supported Versions

Cuttlefish is currently beta software. Security fixes target the latest released
version of `cuttlefish-cli` and the current `main` branch unless a maintainer
announces a wider supported-version window.

## Reporting A Vulnerability

Please do not report exploitable details in a public issue.

Preferred private disclosure path:

1. Use GitHub private vulnerability reporting or a draft security advisory for
   `cephalopod-ai/cuttlefish` when available.
2. If that path is unavailable, open a public issue with only a brief,
   non-sensitive request for a private security contact. Do not include proof of
   concept details, tokens, hostnames, private files, or user data in that issue.

Useful private report details:

- affected version, commit, or package artifact;
- impacted component, endpoint, command, or workflow;
- reproduction steps or a minimal proof of concept;
- expected security boundary and observed bypass;
- whether credentials, local files, or remote execution are involved.

## Response Expectations

Maintainers should acknowledge credible reports, triage severity, and coordinate
fix timing before public disclosure. Critical or actively exploited issues should
be prioritized over normal feature work.

If a secret is ever committed, logged, or included in an issue, rotate it first.
Deleting the value from the repository or issue is not sufficient once it may
have been exposed.

## Scope Notes

Cuttlefish runs local and remote coding CLIs. Treat local filesystem access,
gateway authentication, connector credentials, engine subprocess environment,
package publishing, and release workflows as security-sensitive surfaces.

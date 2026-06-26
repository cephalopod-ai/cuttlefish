# Known Diagnostics

Date: 2026-06-24

This document records accepted, non-actionable diagnostics that future audits
should not re-report unless the audit scope explicitly asks to revisit them or
the underlying behavior changes.

## Kiro Quota And AWS Routing

Status: known, accepted diagnostic.

Kiro is wired as a headless engine with local session continuity and an
estimated credit gauge. The gauge is intentionally not an authoritative provider
quota source because this repository has no stable local Kiro quota endpoint.

This source tree also does not include a scheduler/provider map architecture for
routing Kiro work to AWS, so no Kiro-to-AWS provider mapping is expected here.

Future audits should treat these as documented fidelity limits, not fresh
findings, unless the audit explicitly scopes Kiro quota verification,
Kiro-to-AWS routing, or a new Kiro provider contract.

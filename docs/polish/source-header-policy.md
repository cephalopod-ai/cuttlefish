# Source Header Policy

## Project

Cuttlefish

## Existing Convention Found

No active repo-wide source-header convention exists for TypeScript, TSX, JavaScript, or Markdown files. The repository relies on clear filenames, directory structure, package metadata, and `LICENSE` rather than per-file legal headers.

## Header Template

No broad header template is applied in this pass. If the project later adopts source headers, use concise purpose headers only where they add clarity:

```text
// Project: Cuttlefish
// File: <relative/path>
// Purpose: <one-sentence purpose>
```

## Rules

- Preserve shebangs.
- Preserve encoding declarations.
- Do not duplicate headers.
- Skip generated files unless generated headers are already supported.
- Skip vendored dependencies and build outputs.
- Use the repo license convention where present.
- Avoid adding unsupported legal claims.
- Prefer no header over noisy boilerplate when the file purpose is already clear.

## File Groups Covered

| Pattern | Header style | Included | Notes |
|---|---|---:|---|
| `packages/**/*.ts` | none | no | Existing convention does not use headers. |
| `packages/**/*.tsx` | none | no | Avoid UI churn. |
| `scripts/**/*.mjs` | none | no | Keep executable scripts focused. |
| `docs/**/*.md` | Markdown heading | conditional | Existing docs use headings and indexes. |
| Generated/local artifacts | none | no | Should not be tracked. |


---
name: echoes-create-or-update-page
description: Atomically create a new markdown page or update an existing one in EchoesVault/pages/, automatically updating the index.
---

# TOOL USAGE: echoes_create_or_update_page

Use the Pi tool `echoes_create_or_update_page` when a new global concept is defined or an existing component's architecture fundamentally changes mid-session.

## WHEN TO USE

- Finalizing a database schema or API contract.
- Major refactoring that invalidates prior documentation.
- Documenting a newly integrated library or hardware component.

## RULES

1. **Strict YAML Frontmatter:** Every page must start with YAML metadata (`type`, `stack`, `status`).
2. **Index Sync:** For new files, provide `indexDescription` (e.g. `- [[auth-architecture]]: JWT auth overview.`).
3. **Deprecate, Don't Delete:** Prefer a new page plus a `> [!warning] DEPRECATED` update on the old page.

## PARAMETERS

- `filename` (string): Bare filename (e.g. `auth-architecture.md`).
- `content` (string): Full markdown including YAML frontmatter.
- `indexDescription` (string, optional): Required for new files; format `- [[filename]]: description`.

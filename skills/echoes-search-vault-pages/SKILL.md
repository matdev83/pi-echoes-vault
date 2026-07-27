---
name: echoes-search-vault-pages
description: Search the EchoesVault for specific concepts, keywords, or implementation details.
---

# TOOL USAGE: echoes_search_vault_pages

If you encounter a concept, API, or architectural pattern that may already be documented, call the Pi tool `echoes_search_vault_pages` BEFORE generating code or inventing docs.

## WHEN TO USE

- Modifying an existing component whose structure is not in context.
- Checking whether an ADR exists for a technology choice.
- Fulfilling the Read-Before-Write core rule.

## RULES

1. **Targeted Queries:** Prefer specific technical keywords over natural-language questions.
2. **Handle Deprecations:** If a match is marked `> [!warning] DEPRECATED`, follow the link to the replacement page.

## PARAMETERS

- `query` (string): Keyword or short phrase to search across `EchoesVault/pages/`.

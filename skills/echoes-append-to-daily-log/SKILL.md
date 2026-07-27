---
name: echoes-append-to-daily-log
description: Append an intermediate technical note or decision to today's daily log immediately after completing a sub-task.
---

# TOOL USAGE: echoes_append_to_daily_log

You are equipped with a scratchpad tool to manage cognitive load. Use the Pi tool `echoes_append_to_daily_log` to offload important context into `EchoesVault/daily/YYYY-MM-DD.md`.

## EXACT TRIGGER CONDITIONS

Invoke this tool immediately in the current response if ANY of the following occur:

1. **Task Completion:** A logical unit of work finishes before the next user request.
2. **Context Switch:** The user changes focus (e.g. backend → frontend).
3. **Architectural Agreement:** A core rule, library, schema, or API contract is agreed.
4. **Explicit User Command:** The user says "take a note", "remember this", "save our progress", or "log this".

## RULES

1. **Be Concise:** Dry facts and bullet points only.
2. **Do Not Interrupt Flow:** Call the tool with a brief confirmation at most.
3. **No File Overwrites:** The tool only appends to today's file.

## PARAMETERS

- `logEntry` (string): Markdown bullet points to append (no date/time; the tool timestamps).

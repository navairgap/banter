---
name: code-review
description: Review code for bugs, edge cases, and clarity before shipping.
---

Review the provided code as a thorough senior engineer. Work through it in this order:

1. **Correctness** — logic errors, off-by-ones, null/undefined handling, error paths, race conditions.
2. **Edge cases** — empty inputs, huge inputs, unicode, concurrent calls, partial failures.
3. **Security** — injection, unvalidated input, secret handling, unsafe deserialization.
4. **Clarity** — misleading names, dead code, duplicated logic, missing error messages.

Rules:
- Quote the exact line before each finding and explain the failure scenario concretely.
- Rate each finding CRITICAL / MAJOR / MINOR. Do not pad the list with style nitpicks unless asked.
- Suggest a fix for every finding, as a short diff or one-sentence change.
- If the code is correct, say so plainly instead of inventing problems.

---
name: regex-builder
description: Produce correct regular expressions with test cases, not guesses.
---

For the requested pattern matching task:

1. Restate the match criteria in plain words first (what must match, what must not).
2. Give the regex with inline comments per group where the flavor matters (state the flavor: JavaScript, PCRE, Python…).
3. Provide a test table: at least 3 strings that MUST match, 3 that MUST NOT match, and 1 tricky boundary case.
4. Flag catastrophic backtracking risks (nested quantifiers, ambiguous alternation) and give the safe rewrite if any exist.
5. If the task is better solved without a regex (parsing HTML, JSON, nested structures), say so and recommend the right tool instead.

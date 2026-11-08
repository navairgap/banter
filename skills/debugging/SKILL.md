---
name: debugging
description: Systematic root-cause analysis instead of guess-and-check fixes.
---

Debug the reported problem with a systematic method:

1. **Reproduce** — state exactly what input and conditions trigger the bug. If it cannot be reproduced, say what information you need.
2. **Hypotheses** — list the 2–4 most plausible root causes, ranked by likelihood, with the observable evidence that would confirm or rule out each one.
3. **Discriminate** — give the single cheapest test or log statement that separates the leading hypotheses.
4. **Fix** — only after a cause is established, propose the minimal fix and explain why it addresses the cause rather than the symptom.
5. **Verify** — describe the test that proves the fix and would catch regressions.

Never propose a fix whose only justification is "try this". If forced to guess, label it clearly as a guess and state what would confirm it.

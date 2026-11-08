---
name: skill-creator
description: Write a new SKILL.md that follows this harness's skill format.
---

Help create a new skill for this harness. A skill is a SKILL.md file:

```
---
name: kebab-case-name
description: One line saying when to use it.
---

Imperative instruction body for the model.
```

Rules for a good skill:

- The **description** states when the skill applies, not what it contains — it is used for listing and selection.
- The **body** is written as direct instructions to the model ("Review the code in this order…"), not as documentation about the skill.
- The body must be 10–40 lines: long enough to change behavior, short enough to stay on-topic in a system prompt.
- Include the exact output structure you want (numbered steps, sections, tables) — models follow concrete shapes better than adjectives.
- Forbid common failure modes explicitly ("never invent facts", "if unknown, ask") where they matter.

Produce the full SKILL.md content, then suggest one way to test that the skill changes the model's behavior.

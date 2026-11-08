---
name: sql-assistant
description: Write correct, reviewable SQL with schema assumptions stated.
---

Write the requested SQL:

- State the schema you are assuming (tables, key columns, types) in a short block before the query. Ask for the real schema if the query depends on unknown columns.
- Use explicit JOINs, never comma-joins. Qualify ambiguous columns.
- Call out NULL-semantics gotchas the query relies on (NOT IN vs NOT EXISTS, null comparisons, aggregates skipping nulls).
- Note the expected row-multiplication behavior of joins and where a semi-join (EXISTS) is safer than a plain join.
- Add an EXPLAIN-analyze suggestion for anything scanning large tables, and mention the index each predicate would want.

Finish with one "watch out" line: the most likely way this query silently returns wrong results.

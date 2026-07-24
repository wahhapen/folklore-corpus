# Audit of the 170-story seed

Generated deterministically from the checked-in raw manifest, source books,
compiler boundaries, and derived corpus.

## Result

The seed contains **170 emitted stories**
and **337,379 words** from
**5 English-language editions**. It is useful as
an incubation corpus, but it is not yet a durable Corpus Release.

| Collection | TOC entries | Located headings | Emitted | Words |
| --- | ---: | ---: | ---: | ---: |
| grimm-2591 | 64 | 64 | 62 | 100,439 |
| andersen-1597 | 18 | 18 | 18 | 55,294 |
| english-7439 | 43 | 43 | 43 | 50,999 |
| celtic-7885 | 26 | 25 | 26 | 60,698 |
| japanese-4018 | 21 | 21 | 21 | 69,949 |

## Identity and ML blockers

- Current story IDs are not durable because mutable title slugs are embedded in them.
- The five inputs are English editions; this is not yet a multilingual dataset.
- The output has no Source/Edition/Document/Witness/Passage identity hierarchy.
- The output has no passage-level citations or task-specific split manifests.
- Regex-derived concept suggestions cannot be treated as supervised gold labels.
- The raw manifest identifies mirror URLs but not an upstream revision or per-capture directory.

## Duplicate evidence

- Exact normalized-text duplicate groups: 0
- Repeated normalized-title groups: 0

These counts detect identity candidates, not folklore variants. The complete
groups and field-suitability table are in
[`seed-audit.json`](seed-audit.json).

## Interpretation

- Project Gutenberg wrapper text is removed from every emitted story.
- All 169 current story IDs
  contain a mutable title slug and must not become cross-repository identities.
- Collection and tradition metadata is useful for grouping and diagnostics,
  but would make misleading or trivially leaked classifier targets.
- Motif, being, and role arrays are regex outputs. Predicting them from the
  input text would measure recovery of those regexes, not folklore knowledge.
- The next Corpus work must introduce immutable capture identity, a stable
  Source/Edition/Document/Witness/Passage hierarchy, passage exports, and
  explicit release/split manifests.

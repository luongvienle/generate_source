# Conventions

## Coding Standards

No enforcement exists: there is no `.editorconfig`, no linter config, and no
formatter config in the repository [verified]. No source file exists to observe
style from [verified].

The spec states the following standards, which will govern the implementation
`[declared]`:

- **Database columns are `snake_case`**; API and JSON fields are `camelCase` —
  visible throughout §8 (`draft_content_markdown`, `access_duration_days`)
  versus §9.1 (`levelLabel`, `estimatedTotalMinutes`).
- **Enum-like values are stored as `TEXT` and validated in the application
  layer**, deliberately, to keep migrations cheap (§8). The allowed values for
  every such column are tabulated in §8.1.
- **Lesson bodies are stored as markdown, never HTML**, so content stays
  portable and diffable (NFR-10).
- **Block IDs derive from a stable persisted counter, not content hashing**, so
  editing a paragraph's text does not change its id (§6.1).
- **Figure and table numbering is assigned in exactly one place** — the block
  extractor; the renderer and the narration generator both read those numbers
  and neither recomputes them (§6.1).
- **All prompts are versioned**, and `promptVersion` is stored with every
  generated artifact (NFR-08, and `generator_prompt_version` in §8).
- **Structured logging on every job** with `jobType`, `targetEntityId` and
  `attemptCount` (NFR-07).
- **Naming choice to be preserved:** the entity is called `Course` in code even
  though the product calls it a *level*; it is the unit that is published, sold,
  enrolled in and progress-tracked (§4.1).

## Naming & Layout Patterns

No source layout exists to observe [verified]. The spec declares a `/apps` +
`/packages` + `/docs` layout, reproduced in `overview.md` `[declared]` (§11).
Test file placement is `Unknown` — the spec mandates specific tests but says
nothing about where they live.

Document language: the specification is written in **English** [verified]. Its
header declares a companion document, `knowledge-explorer-design.md`, in
**Vietnamese**, carrying the same decisions with more rationale `[declared]` —
that file is **not present in this repository** [verified].

## Commit Conventions

`Unknown`. This directory is **not a git repository** [verified], so
`commit: unavailable` and there is no history from which to derive a commit
message style.

## Notes


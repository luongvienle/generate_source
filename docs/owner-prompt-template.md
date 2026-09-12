# Curriculum outline prompt template

**schemaVersion: 1.0.0**

FR-IMP-03. Paste everything below the line into your AI account, replace the
bracketed parts, and paste the JSON it returns into the import screen. Run the
dry run before committing — it tells you exactly what will be created, updated,
deleted and what conflicts, and writes nothing.

This template is versioned alongside `docs/import-schema.json`. If the import
screen rejects your payload with a schema-version error, download this file
again — the shape has changed.

---

You are helping me draft a course outline for a learning platform. Return
**only** a single JSON object, with no prose before or after it and no markdown
code fence.

The course I want is:

- Subject area: [e.g. Japanese]
- Level: [e.g. N5]
- Where this level sits among the levels of that subject: [e.g. 1, the first]
- Language the lessons are written in: [e.g. vi]
- Roughly how many chapters: [e.g. 8]
- Roughly how many lessons per chapter: [e.g. 5]
- Anything the course must cover: [optional]

Produce JSON in exactly this shape:

```json
{
  "schemaVersion": "1.0.0",
  "category": {
    "slug": "japanese",
    "displayName": "Japanese"
  },
  "course": {
    "levelLabel": "N5",
    "levelOrder": 1,
    "title": "Japanese N5",
    "overviewSummary": "At most 3 sentences.",
    "prerequisites": ["None"],
    "learningObjectives": ["Read hiragana and katakana fluently"],
    "estimatedTotalMinutes": 1200,
    "languageCode": "vi"
  },
  "chapters": [
    {
      "chapterOrder": 1,
      "title": "Hiragana",
      "description": "One or two sentences.",
      "lessons": [
        {
          "lessonOrder": 1,
          "title": "The A-row",
          "learningObjective": "One sentence, what the learner can do afterwards.",
          "keyPoints": ["あ i u e o", "Stroke order"],
          "estimatedMinutes": 15
        }
      ]
    }
  ]
}
```

Rules you must follow, because the importer rejects the payload otherwise:

1. `schemaVersion` must be exactly `"1.0.0"`.
2. Include **no** keys beyond the ones shown. Unknown keys are rejected, not
   ignored.
3. `category.slug` is lowercase words joined by single hyphens — `japanese`,
   `data-science`. It identifies the subject area across every level, so reuse
   the same slug for every level of the same subject.
4. `chapterOrder` starts at 1 and is unique within the course.
   `lessonOrder` starts at 1 and is unique within its chapter. Both are whole
   numbers above zero.
5. `levelOrder` is this level's position among the levels of its subject —
   1 for the first, 2 for the next — and no two levels of one subject may share
   a number.
6. Every chapter needs at least one lesson, and the course needs at least one
   chapter.
7. These are required: `category.slug`, `category.displayName`,
   `course.levelLabel`, `course.levelOrder`, `course.title`, `chapterOrder`,
   chapter `title`, `lessons`, `lessonOrder`, lesson `title`.
   Everything else may be omitted, but omit it rather than sending `null` or
   an empty string.
8. Write titles and objectives in the language given above, not in English,
   unless that language *is* English.
9. Do not write lesson body content. This outline is a skeleton — the body of
   each lesson is written later, by hand, in the editor.

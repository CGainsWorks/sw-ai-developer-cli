You are producing a patch against an existing project.

Output a single unified diff and nothing else. No prose before it, no prose
after it, no Markdown code fence.

Format requirements — a patch that violates these cannot be applied:

- Start each file with `--- a/<path>` then `+++ b/<path>`, using the exact
  paths given to you below.
- For a new file use `--- /dev/null` and `+++ b/<path>`.
- Every hunk header must be `@@ -oldStart,oldCount +newStart,newCount @@` with
  line numbers that match the file contents you were given.
- Include at least three lines of unchanged context around each change, unless
  the change is at the start or end of the file.
- Context and removed lines must reproduce the original file *exactly*,
  including indentation and trailing whitespace.

Match the surrounding code's language, formatting and idiom. Do not emit
placeholders or `TODO` markers.

{{context}}

Request:
{{request}}

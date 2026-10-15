Write a Conventional Commits message for the staged change below.

Format:

```
<type>(<scope>): <subject>

<body>
```

Rules:

- `type` is one of: {{types}}.
- `scope` is optional. Use the package, module or directory the change is
  centred on. Omit it, and the parentheses, if the change is repo-wide.
- `subject` is imperative mood, lower case, no trailing full stop, at most
  {{subjectMaxLength}} characters.
- `body` is optional. Include it only when the *why* is not obvious from the
  subject. Wrap at 72 columns. Do not list the files changed — the diff already
  does that.
- Add a `BREAKING CHANGE: <description>` footer if, and only if, the change
  removes or alters existing public behaviour.

Output the commit message only. No code fence, no commentary.

Diff:

```
{{diff}}
```

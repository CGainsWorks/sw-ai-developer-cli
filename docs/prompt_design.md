# Prompt design notes

Why the templates in [`templates/`](../templates) are shaped the way they are.
These are engineering decisions with failure modes attached, not style
preferences — each section names the specific bad output the wording exists to
prevent.

Templates are plain Markdown with `{{placeholder}}` substitution so they can be
diffed, reviewed and overridden without a rebuild. Point `templatesDir` at a
directory to override any of them individually; anything you do not override
falls back to the packaged copy.

---

## Principles that apply to all of them

**An unfilled placeholder is an error.** `renderTemplate` throws rather than
substituting an empty string. A review prompt that silently loses its diff does
not fail — it returns a confident review of nothing, which is the worst
available outcome. Failing loudly costs a stack trace; failing quietly costs
trust in every result the tool has ever produced.

**Say what not to output, not just what to output.** Models default to a
conversational wrapper: "Sure! Here's the code:", a fenced block, then "Let me
know if you'd like me to adjust anything." For a CLI whose output is piped into
a file, all three are corruption. Every template that produces machine-consumed
output says so explicitly — and the code still strips fences afterwards,
because instructions reduce the rate but do not eliminate it.

**Give an explicit exit for "nothing to report".** Without one, a model asked to
find problems will find problems. The review template states that an empty array
is a valid and expected answer. This is the single highest-leverage line in the
whole set: without it, review output on a clean diff is padded with speculation,
and a tool that cries wolf on clean diffs gets switched off.

**Do not ask for what the model cannot know.** The review template gets a diff,
not whole files, so it is told not to guess at surrounding code. Otherwise it
reasons about function bodies it has never seen and reports failures that cannot
happen.

**Constrain the shape, then validate it anyway.** Requests use a JSON schema
where the provider supports one, but `normaliseComments` still treats the result
as untrusted: unknown file paths are repaired or dropped, out-of-range line
numbers are snapped to a changed line or demoted to file-level, unknown
severities become `warning`. Prompt instructions raise the probability of good
output; they never guarantee it.

---

## `review.md`

The one that matters most, because a bad review prompt produces plausible noise
rather than obvious failure.

**Line numbers in the gutter.** The diff is rendered by `annotateForReview` with
post-change line numbers already attached:

```
    10 |   const a = 1;
     - |   return a + b;
    12+|   const c = 3;
```

Asking a model to derive line numbers from `@@ -10,7 +10,8 @@` headers produces
off-by-several errors that make every comment land on the wrong line. Removed
lines get `-` instead of a number, because they do not exist in the file a
reviewer will open.

**An explicit list of what not to report.** Formatting, naming and style are
excluded by name. They are what a model reaches for when it cannot find a real
defect, and they are what makes reviewers stop reading. Speculative
"consider maybe" suggestions are excluded for the same reason.

**Severity defined by consequence, not by feeling.** `error` is "will produce
wrong behaviour, data loss, or a vulnerability"; `warning` is "likely a defect,
or a real risk under plausible input". Left undefined, severity tracks the
model's confidence in its own prose rather than the impact of the bug — and
`--fail-on error` is a CI gate, so that distinction decides whether builds break.

**Deterministic rules are not in the prompt.** `debugger`, `console.log`,
hardcoded credentials and focused tests are caught by the `review-policy`
plugin's regexes instead. A model asked to also do grep work is slower, costlier,
and less repeatable at it. The prompt covers what needs judgement; the plugin
covers what needs precision.

---

## `generate.md` and `generate-patch.md`

Two templates rather than one, because the failure modes are different.

**`generate.md`** produces a file body. It leads with "match the surrounding
code" — its formatting, naming, comment density, error-handling idiom — because
generated code that is *correct* but stylistically foreign still gets rewritten
by hand, which wastes the entire exercise.

It forbids placeholders explicitly. "`// ... rest of implementation here`" in a
file the tool just wrote to disk is worse than no file: it looks finished. If
part of the request cannot be satisfied from the context provided, the template
asks for a comment saying so, so the gap is visible rather than invented.

**`generate-patch.md`** produces a unified diff, and is mostly a format
specification because that is where patches fail. It requires exact paths,
correct `@@` ranges, at least three lines of context, and byte-exact
reproduction of context and removed lines. Trailing whitespace differences alone
are enough to make a hunk unapplyable.

The patch is then validated by the parser and applied by
[`src/output/patch.ts`](../src/output/patch.ts), which searches a window around
the stated position for the context — so a slightly stale line number still
applies. The prompt reduces the failure rate; the applier absorbs what is left.
Anything the applier cannot place is reported as a rejected hunk, and the file
is left untouched, because a half-applied file looks like it worked.

---

## `explain.md`

Optimised against the two failure modes of "explain this code": line-by-line
narration, and padding.

**Lead with what it is for.** No preamble, no restating the question. An
explanation whose first sentence is "This code defines a function called
`calculateTotal`" has told the reader something they could see.

**"Only where the code actually warrants it."** The template lists what to cover
— non-obvious control flow, unstated invariants, edge cases handled and not
handled, anything that looks like a trap — but qualifies it. Without that
qualifier, every section gets filled whether or not the code has anything to say
under it, and the invented content is indistinguishable from the real content.

**No syntax explanation, no closing summary.** Both are pure token cost for the
audience this tool has.

`--detail brief|normal|deep` swaps one instruction line. Length control belongs
in a flag, not in the user having to phrase the request differently.

---

## `commit-message.md`

The most constrained template, and the only one whose output is checked against
a grammar afterwards.

It specifies the Conventional Commits format, the allowed types (configurable),
imperative mood, lower case, no trailing full stop, and a subject length limit.
It explicitly says not to list the changed files: the diff already does that,
and a commit body that restates it is noise in every `git log` from then on.

`BREAKING CHANGE` is gated behind "if, and only if, the change removes or alters
existing public behaviour". Left open, models add it generously — and with
semantic-release wired up, that publishes a major version. A prompt line here is
load-bearing on the version number.

Because the output feeds an automated release, `validateMessage` parses the
result and `swai commit-msg` exits `5` if it does not conform. The prompt makes
conformance likely; the validator makes it verifiable.

---

## Things deliberately left out

**Few-shot examples.** They would improve consistency, but they cost input
tokens on every call and bias output towards the examples' domain — a review
prompt with three JavaScript examples reviews Python worse. The templates
describe the task instead of demonstrating it. Revisit this per-project via
`templatesDir` if a codebase has a genuinely unusual house style.

**Chain-of-thought instructions.** Current models decide reasoning depth
themselves, and asking for step-by-step reasoning in the response body pollutes
output that is being piped to a file.

**Sampling parameters.** Not a prompt decision but worth recording here: neither
built-in provider sends `temperature` or `top_p`. Some current reasoning models
reject them outright and the request would fail rather than degrade. Steering
happens in the prompt, which also keeps behaviour comparable between the hosted
API and a self-hosted model.

**Prompt caching.** The templates are static and would cache well, but the
per-request payload — the diff, the file, the request — dominates. There is
nothing worth caching until this grows a large shared system prompt.

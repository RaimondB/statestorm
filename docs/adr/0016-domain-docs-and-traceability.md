# ADR 0016 — A domain's decisions are data, and the model says which it implements

- **Status:** proposed, 2026-11-02
- **Decides:** where a domain folder keeps its rules, glossary, open questions and decision log;
  their formats (`schemas/`); how a domain adds its own fields on top (`docs/profile.yaml`); and
  how the model, the scenarios and the drawing issues point at a rule (`why:`) so the model check
  can trace them
- **Builds on:** ADR 0013 (packages — a topic of rules is drawn around them), the model check's
  coverage (`coverage.ignore`) and drawing issues (`issues.yaml`, MC-14), reference tags (a tag
  shaped like an outside id, `TP-12`, is a reference)
- **Forced by:** the way of working itself (AGENTS.md, rule 1). A domain's decisions are numbered,
  dated lines in one domain doc, appended in the order they were decided. As a domain grows, what
  holds for one topic today is spread over every session, behind its revisions; the rule numbers in
  the model and the scenarios are comments, which no tool reads. An agent reads the whole doc
  before it knows where the domain stands, and still cannot ask "which agreed rule has no
  scenario" or "which comment cites a revised rule".

## Context

The way of working already treats a decision as a numbered, citable line, and says where it is
cited: the model's comments, a scenario's header, a drawing issue's `why`. What is missing is a
form the platform can read. Three readers need different things from the same lines:

- the **domain owner** wants the current truth per topic, readable, with what is still open;
- an **agent** wants a small index, one topic at a time, and to be told at once when an edit breaks
  a reference;
- the **model check** wants ids it can resolve, so a dangling or stale reference is a finding,
  not something a reader may notice.

The history matters too — "never silently rewrite a decision" — but it is a log, not the rulebook.
Kept as one document, either the history buries the current truth or the current truth is
rewritten and the history is lost.

## Decision

### The domain folder

1. **A domain folder may have `docs/`** beside `model.yaml`, `scenarios/` and `drawings/`. Every
   file in it is optional; a domain without it is checked as today. In this repo, a neutral example
   keeps them in `packages/examples/docs/<model>/`.

   ```
   docs/
     profile.yaml               what this domain adds to the formats below (§ Extending)
     glossary.yaml              the ubiquitous language
     rules/<topic>.yaml         the rules that hold today, one file per topic
     questions.yaml             what is asked and not yet decided, each with its leaning
     decisions/NN-<date>-<what>.md    the log: one session each, as it happened; never edited after
     rulebook/                  generated from the above (§ 9); committed, never edited
   ```

2. **The current truth and the history are kept apart.** `rules/` holds each rule's wording as it
   stands; `decisions/` holds how it got there. A session appends its log and changes the rules it
   decided, in one commit. The log is Markdown and is not parsed, except for the ids in it.

### The formats (`schemas/*.schema.json`, JSON Schema 2020-12)

3. **A rule** — `rules/<topic>.yaml`, a topic per file, its file name the topic's id:
   - `id` — any string, unique across the domain's rules, questions and drawing issues (`R12`).
     The platform gives ids no shape; a domain keeps its own numbering.
   - `title` — one line; `text` — the rule as it holds today, in the domain's words.
   - `kind` — `definitional` (what something is: "a request has one route per lab its samples go
     to") or `behavioural` (what must happen: "a sample past its stability is not run"), as SBVR
     separates them; or `table`, with a `table: { columns, rows }` for a rule that is a decision
     table (DMN's idea, not its notation).
   - `status` — `agreed`; `to-confirm` (built on a leaning the owner has not yet confirmed);
     `deferred` (left out on purpose — a line, so it is not mistaken for a gap); `superseded`.
   - how it changed an earlier rule, **said only on the newer one**: `refines` (adds to it — both
     hold), `revises` (changes part of it — the older text is rewritten to what still holds),
     `supersedes` (replaces it — the older one's status becomes `superseded`). The back-links are
     derived, never written twice.
   - `decided` — `{ session, date, questions }`: the log it was decided in and the questions it
     answers.
   - `untraced` — why this rule has no model element or no scenario, when that is right (a
     statement about the organisation, nothing to build). Like `coverage.ignore`, it says why.

   The topic file has a `title`, the rules, and a `canvas` — the parts of the Bounded Context
   Canvas (DDD Crew) that must be written: `purpose`, and the `packages` (ADR 0013) or `types` the
   topic is about. A cross-cutting topic names neither. What the canvas would otherwise list — the
   commands in, the events out, the policies — is derived from the model when the rulebook is
   generated, never written.

4. **The glossary** — one entry per term: `term`, `definition`, `aka` (synonyms in use), `avoid`
   (words not to use for it, and why), and `model` — the types, events or states it names, checked
   against the model.

5. **A question** — `id`, `question`, `leaning` (the default that will be built), `options` (each
   with its consequence), `status` (`open`, `answered`, `withdrawn`), `asked` (`{ session, date }`),
   and, once answered, `answer` and `answeredBy` (the rules that record the answer). A question is
   not a rule: an answered one keeps its id, and the rule says what was decided.

### Pointing at a rule: `why:`

6. **`why:` is a list of ids**, and is accepted — carried by the kernel, ignored at run — on:
   an aggregate and a policy (beside `extends`, `data`, …), a state, a transition (under `on:`,
   `after:`, `on_children:`, `on_done:`), and a package. A scenario has a top-level `why:` beside
   `tags:`: the rules it shows. The loader refuses a `why:` that is not a list of ids, as it refuses
   an unknown key. Each id must resolve to a rule, a question or a drawing issue of the domain, or
   carry an outside prefix the profile declares (§ 8); the model check says any other as an error —
   a reference that cannot be followed is loud. A `why:` on a state or a rule stays where it was
   written: a subtype does not cite what its supertype does, so a rule is traced to one place.

   Tags stay what they are: the topics a scenario is about, and the outside items it proves
   (`TP-12`). `why:` is the domain's own decisions.

7. **Prose may cite ids too**: a drawing issue's `why:` stays free text, and the ids in it count;
   so do the ids in a decision log, and — during a migration only — in the model's comments. A word
   in prose is an id only if it is one of the domain's ids or carries a declared outside prefix;
   prose is never an error, only a source of references.

### Extending: `docs/profile.yaml`

8. **The base formats are what every domain shares; a domain adds to them in its profile, never
   by changing them.** A profile declares:
   - `fields` — extra fields on a rule, a glossary entry or a question, each with a `description`
     and a type: `string`, `number`, `boolean`, a list of one of those, an `enum`, or a
     `vocabulary` (a YAML file listing the allowed values, for a controlled vocabulary such as an
     industry standard's). The platform validates them and shows them; it never knows what they mean.
   - `external` — the prefixes of outside lists the domain cites (`TP: the test plan`), so a
     `why:` or a tag with one is a reference, not a typo.
   - `topics` — the order the rulebook reads in (otherwise by file name).

   So no domain's words enter the platform: an industry vocabulary, a release the rule applies
   from or a test plan is a field or a prefix in that domain's profile.

### What the platform does with it

9. **The rulebook is generated** — `docs/rulebook/`, Markdown: an index (one line per rule:
   id, status, topic, title), a page per topic (its canvas with what the model derives, its rules
   with their status, how each changed an earlier one and was changed since, the model elements
   and scenarios that cite it, the drawing issues), the glossary, and the open questions. It is
   committed, so it reads on GitHub and in a pull request; it says at its top which file to edit
   instead; and the model check fails when it is stale. The workbench shows the same, and shows a
   state's or transition's rules beside it.

10. **The model check traces** — as findings, with the rule they are about:
    - *dangling*: a `why:` id nothing defines (an error, § 6);
    - *stale*: a `why:` that points at a `superseded` rule;
    - *untraced*: an `agreed` or `to-confirm` rule no model element or no scenario cites, unless it
      says `untraced:` why;
    - *waiting on the owner*: a model element or scenario that cites a `to-confirm` rule or an
      `open` question — the list for the next session;
    - *only in a comment*: an id cited in a model comment and in no `why:` — the migration's list;
    - *glossary drift*: a term naming no type, event or state of the model (an error); a type of
      a moved topic — declared by its packages, or listed in its canvas — that no term names (a
      warning: a topic brings its words); another packaged aggregate no term names (info);
    - *canvas drift*: a topic's `packages` or `types` the model does not have (an error);
    - *inconsistent*: a rule `superseded` by a newer one whose status is not `superseded`, an id
      used twice, an answered question with no `answeredBy`, a `decided.session` with no log.

11. **Agents read through queries**, not files: an index of every rule, one rule with everything
    that cites it, one topic, what is open. A fast `check --docs` — no scenario runs — is what a
    hook runs after an edit. A domain repo points its YAML files at the schemas for its editor
    (`# yaml-language-server: $schema=…`); a domain with a profile points them at the schemas the
    platform merges from the base and the profile.

## Consequences

- The schemas ship with the package (`schemas/`, in `files`), so a domain repo's editor finds them
  under `node_modules/statestorm/schemas/`.
- The kernel's loader accepts `why:` where § 6 says; nothing at run reads it. `Model` carries it,
  so the check, the query and the workbench read one structure.
- The check validates the docs with Ajv against the shipped schemas — the schemas are the one
  statement of the formats, not a second copy in code. A file that does not match its schema is
  said once; the ids in it are still read, so the references to them are not each said again.
- A topic's canvas lists its packages' types with the entities inside their aggregates (ADR 0013
  §2–3) — the rule the structure view draws by, now in one module both use.
- A domain migrates one topic at a time: until a topic's rules are in `docs/rules/`, the ids its
  model comments cite are reported as *only in a comment*, not as errors.
- `statestorm rules` is the query of § 11 (`<id>`, `--topic=`, `--open`, `--json`). The hooks are
  templates a domain repo copies (`templates/`): one script, run by Claude Code (exit 2, stderr)
  and by GitHub Copilot (`additionalContext` on stdout), and a git pre-commit hook for everyone
  else. The platform installs nothing into a domain repo by itself.
- The neutral `lab` example gains `docs/lab/` — rules, a glossary, a question, a profile with one
  extra field and one outside prefix — and its model and scenarios cite them, so the check's
  findings and the generator have a fixture with no domain. Its drawing issues are already `L-1`,
  `L-2`, …, so its rules are `R1`, `R2`, …: one id space across rules, questions and issues.
- Ids stay the domain's. Two numbering schemes that read alike (`D-1`, `D-01`) are not an error
  but read as one; a domain renumbers one of them when it migrates.
- Rejected:
  - *Markdown rules with a fixed heading shape.* Readable as written, but a second parser for a
    format nothing enforces; the fields (status, what it revises) are the part a tool must read.
    YAML already holds prose here (`issues.yaml`), and the owner reads the generated rulebook.
  - *The rule's text in the model* (a `note:` per transition). It doubles the model's size for the
    reader who needs it least, and two copies of a rule drift. The model holds the id; the
    workbench and the query bring the text.
  - *Back-links written on both rules* (`revisedBy`). Written twice, wrong once; they are derived.
  - *Id patterns in the profile.* The ids are known from the files that define them; a pattern
    would only re-say it, and would be needed for nothing but outside prefixes.
  - *A standard adopted whole* (SBVR, arc42, ISO/IEC/IEEE 29148). Each gives one part — the split
    of definitional and behavioural rules, the canvas, the traceability matrix — and none fits a
    model that runs; a domain adds an industry's vocabulary through its profile.
  - *`rules:` as the key.* In the kernel a rule is a transition (ADR 0008: "inherited rules are
    tried first"); `why:` says what it holds, as it does in `issues.yaml`.

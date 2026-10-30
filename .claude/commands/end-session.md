---
command: end-session
description: Wrap up the work session with read-only evidence gathering, owner-classified documentation handoffs, gated issue sync, Kano refinement, and git hygiene checks.
argument-hint: [optional focus or extra notes to weave in]
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# /end-session — session wrap-up

A maintainer ritual for this repository. It reconstructs the session, classifies durable
knowledge by owner, and returns reviewable handoffs without writing to another repository.

| Owner | Canonical destination | Content |
|---|---|---|
| qaren-workspace | [Engineering docs](https://github.com/Lykhoyda/qaren-workspace/tree/main/docs/) | Process, planning, routine engineering decisions, bugs, stories, specifications, diagnostics, comparisons, and research |
| Anton Factory | [architect-docs](https://github.com/Lykhoyda/anton-factory/tree/main/architect-docs/) | Captain-approved architecture vision, ADRs, authority contracts, settled decisions, evidence indexes, and architecture changelogs |
| rn-dev-agent | `apps/docs-site` | Public product and user documentation only |

`$ARGUMENTS` is an explicit maintainer focus. Weave it into the reconstruction; it does
not replace evidence gathering.

## Iron rules

1. **Read other repositories; never write them.** Produce exact handoff blocks and target
   links in the final report. Do not edit a sibling checkout, clone another repository, or
   add cross-repository automation.
2. **Never create top-level `docs/` here.** Engineering material belongs in the workspace;
   product documentation remains under `apps/docs-site`.
3. **Classify before drafting.** Routine engineering and process decisions go to workspace
   docs. Only captain-approved, settled architecture goes to Anton Factory architect-docs.
   An unapproved proposal remains workspace planning material, never a Factory ADR.
4. **Use pointers across owners.** A Factory architecture handoff links to workspace process
   evidence instead of copying its narrative. A workspace handoff links to any accepted
   Factory record instead of duplicating the architecture record.
5. **Never fabricate.** Omit a handoff category when the session produced nothing that
   qualifies. Use today's date from `date +%F` and preserve the destination's established
   format and sequence when it can be read.
6. **GitHub mutation is gated.** Creating issues and applying Kano labels are the only
   outward writes. Present the exact plan and wait for explicit maintainer confirmation.

## Procedure

### Step 0 — Establish read-only sources

- Use the canonical GitHub links above as the durable destinations.
- If `../qaren-workspace` exists, it may be inspected read-only for current IDs,
  formats, prior entries, and deduplication. Never modify it.
- If Anton Factory is accessible, inspect architect-docs read-only to identify accepted
  architecture records and established handoff format. Never modify it.
- If either owner is unavailable, continue with an explicitly unnumbered draft and report
  that the destination owner must assign the final ID.

### Step 1 — Gather evidence

Read before drafting:

- `date +%F`
- `git log --oneline -25`, `git status --short`, and `git branch --show-current`
- `gh pr list --state merged --limit 10` and `gh issue list --state all --limit 200`
- the current workspace roadmap, decision, and bug formats when accessible
- accepted Anton Factory architect-docs records when accessible
- this conversation: shipped work, choices, defects, findings, and unfinished follow-ups

Reconcile existing destination content instead of drafting duplicates. A duplicate handoff
is worse than none.

### Step 2 — Classify and draft durable handoffs

For each candidate, choose exactly one primary owner:

```text
Session knowledge
├── Public product/user guidance ──► rn-dev-agent apps/docs-site
├── Captain-approved settled architecture ──► Anton Factory architect-docs
└── Everything else engineering-related ──► qaren-workspace docs
```

Draft workspace handoffs for:

- a dated roadmap narrative covering shipped work, findings, process, forward work, and refs;
- routine engineering or process decisions with context, choice, rejected alternatives, and
  durable lesson;
- newly discovered or fixed defects with observed behavior, fix or proposed fix, and refs.

Draft a Factory handoff only when explicit captain approval evidence and settled-architecture
status are both present. Settled status without captain approval remains workspace planning
material. Include:

- proposed title and record type;
- captain approval evidence and settled status;
- concise context, decision, rejected alternatives, and durable lesson;
- source code, issue, PR, and commit links;
- pointers to workspace process or research evidence, without copying that material.

Do not assign a Factory ADR number unless the current architect-docs sequence was read.
Never put architecture into rn-dev-agent top-level docs or route it to workspace merely
because the older workflow treated every decision as a workspace ADR.

### Step 3 — Sync unfiled follow-ups to GitHub issues

1. Collect genuinely unfiled follow-ups from the workspace handoff drafts and open bug
   evidence.
2. Deduplicate against `gh issue list --state all --limit 200` and existing cited issue IDs.
3. Draft each remaining issue with title, concise body, source context, and suggested labels.
4. Present the exact set and wait for maintainer confirmation.
5. On confirmation, create the issues and add their links to the corresponding handoff
   drafts. On decline, leave them as proposed items in the final report.

### Step 4 — Kano backlog refinement

Invoke the `kano-backlog` skill after issue sync so any newly created issue is included.
Its label mutations remain gated by its own confirmation flow. Return the recommended next
pick in the session report.

### Step 5 — Hygiene check

- Separate uncommitted work into session changes, prior-session leftovers, and unexplained
  changes. Show a small diff for unexplained tracked changes.
- If shippable source changed against the branch base, confirm a matching changeset exists
  and flag any omission.
- Report the branch, its relation to `main`, and any open PR.
- Do not fix hygiene findings during this command.

### Step 6 — Summarize

Return a compact report containing:

- owner-classified workspace and Factory handoff drafts with canonical target links;
- omitted categories and the evidence for omitting them;
- issues created or proposed, plus the Kano next pick;
- hygiene flags and exact current-repository files requiring maintainer review;
- an explicit statement that no other repository was modified.

The handoff is the deliverable. Destination owners review and persist it in their own
repositories.

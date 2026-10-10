# Spec: [Feature or Project Name]

<!-- Lives at docs/SPEC_TEMPLATE.md. Copy to docs/adr/YYYY-MM-DD-feature-name.md and fill in.
     Keep it proportional: a small feature may need a few lines per section.
     Sections are in dependency order: each one feeds the next. -->

**Status:** Draft | Approved | Implemented
**Date:**
**Scope in one sentence:**

## Open questions and assumptions

- (List anything unconfirmed. Resolve before coding.)

## 1. Requirements

**User outcome:** What is the user trying to do, and what does success look like?

**Functional requirements**
- ...

**Non-functional requirements** (these drive the architecture, so set them first)
- Performance targets (e.g., "refresh completes in under N seconds")
- Scale (how many items, users, or requests)
- Reliability (what must never be lost or corrupted)

**Non-goals** (what this deliberately does not do)
- ...

**Acceptance criteria: trust and quality**
- Data collected, and why it is needed:
- Permissions requested, when, and why:
- Accessibility considerations:
- What happens when AI output is wrong? Can the user edit, undo, or revert it?

## 2. Architecture / Design

**Components** (what exists and what each one owns)
- ...

**Data flow** (how information moves; mark where state changes)
- ...

**Dependency map** (which component depends on which, and in what direction)
- ...

**Impact check on existing code**
- Components this feature touches:
- What else depends on them:
- Contracts that could break:

**Delete check:** What in this design could be removed without hurting the user outcome?

## 3. Data model / schema

| Entity | Fields (name: type) | Constraints and invariants |
|---|---|---|
| | | |

Rules that must always hold (e.g., normalization, uniqueness, retention):
- ...

## 4. Interface contracts

For each boundary between components or with the outside world:

| Interface | Inputs | Outputs | Errors it can raise | Who may call / mutate |
|---|---|---|---|---|
| | | | | |

## 5. Error handling and edge cases

List these before writing tests; they decide what the tests cover.

| Scenario | Expected behavior | Detected how | Covered by test (ID) |
|---|---|---|---|
| Dependency is down | | | |
| Input is malformed or empty | | | |
| Limits hit (size, rate, time) | | | |
| Partial failure / retry | | | |

## 6. Integration tests

Scenarios derived from the architecture and contracts above. Each should name the
components involved and the end state to verify.

- [ ] IT-1: ...
- [ ] IT-2: ...
- [ ] Does this feature still work when the other existing features are active?

## 7. Unit tests

Small, deterministic tests for the pieces that make the contracts work.

- [ ] UT-1: ...
- [ ] UT-2: ...

## 8. Dependencies

| Dependency | Pinned version | Why needed | Known risks |
|---|---|---|---|
| | | | |

## 9. Deployment, configuration, and rollout

- How it runs (where, how started):
- Configuration needed:
- Release mode: flag | dry-run | direct. If risky, describe the dry-run (what is logged but not acted on).
- Signals to watch (a few): errors, latency, failed deploys.
- **Rollback trigger:** what you watch, and what threshold means undo.
- Docs to update with this change:

## Change log

- YYYY-MM-DD: initial draft

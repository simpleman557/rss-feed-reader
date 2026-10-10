# Engineering Philosophy

<!-- Lives at docs/PHILOSOPHY.md in each repo. NOT auto-loaded: read it for architecture
     reviews, or when a rule in CLAUDE.md seems wrong and the "why" is needed. -->

## Purpose

This explains why the rules in `CLAUDE.md` exist. It is for a solo builder who writes
code almost entirely with AI. It borrows from large companies, scaled down. It does not
copy any company's process literally.

## The stance in one line

**Google owns engineering discipline. Apple owns the product bar. Tesla owns scope
discipline and iteration speed.**

| Source | What we take | What it shows up as |
|---|---|---|
| Google | Design docs, small reviewable changes, docs in the repo, layered tests, measuring delivery, supply-chain hygiene | `CLAUDE.md` sections 1, 3, 5, 8; dependency pinning |
| Apple | Privacy, accessibility, responsiveness, reversible AI output as shipping requirements | Section 7 and the acceptance criteria in the spec template |
| Tesla | Question requirements, delete first, simplify, then speed up and automate last; test risky behavior in shadow or dry-run mode | Section 6 (keep scope small) and section 7 (dry runs) |

## The one rule everything serves

**Make the AI produce small, self-contained, reviewable changes against a written spec,
with immediate automated checks and a fast way to roll back.**

```
Spec -> critique -> one small change (code + tests + docs)
     -> local checks -> CI checks -> release behind flag/dry-run
     -> observe -> healthy? broaden : roll back and write a short postmortem
```

## Why the spec comes first

Bugs that arrive one at a time usually come from interactions nobody wrote down:
two features sharing data, a contract assumed differently on each side, a failure mode
no one listed. The spec forces those into the open before code exists. Order matters:
requirements drive architecture; architecture defines the data model and contracts;
edge cases, contracts, and data model together decide what integration tests must prove;
integration tests drive unit tests.

## When the philosophies conflict

1. **Speed vs. stability.** Use Tesla to cut scope, Google to control release risk,
   Apple to define "good enough to ship." Never scale speed without scaling the controls.
2. **Telemetry vs. privacy.** Measure performance and correctness aggressively, but
   minimize personal data. Default to the Apple posture unless the product truly needs
   rich user data.
3. **Open tooling vs. tight integration.** Imitate integrated *responsibility* (you own
   design, code, deploy, metrics, and support), not integrated infrastructure. Open-source
   tools are fine.

## Caveats on the evidence

- Google and Apple practices come mostly from official documentation.
- Tesla's evidence is thinner: official pages and patents, plus secondary reporting and
  anecdotes. Treat the Tesla ideas as useful framing, not proven process.
- Staged experimentation is for software behavior (ranking, prompts, recommendations),
  not for using real users as unwitting test subjects on high-risk behavior.
- Delivery metrics: track both throughput (deploy frequency, lead time) and
  instability (failed deploys, recovery time). DORA's current guidance uses five
  metrics, not the older four. The lesson is the same: speed alone misleads.

## Failure modes to watch

- Specs that become paperwork: keep them short for small features.
- Over-deleting scope until reliability or compliance suffers: add back deliberately.
- AI-written tests that mirror the code and miss real defects.
- Measuring too much. A few signals beat a dashboard nobody reads.

## When to revisit

Rarely. Only if how you build changes fundamentally (team size, product risk, tooling).
To change a rule day to day, edit `CLAUDE.md`; do not rewrite this file.

# Architecture

This document is the long version of "how rem works". It is intentionally
implementation-first: the README sells the idea, this file explains the machinery.

## 1. Goals and non-goals

**Goals**

- Compress the *original* transcript, not only extract from it.
- Keep every compressed layer traceable to a source range.
- Consolidate offline, in stages, with a bounded budget.
- Let humans review anything the model invented.
- Store everything as plain, inspectable data.

**Non-goals (for now)**

- Cross-harness support (Claude Code, Codex). The engine is harness-agnostic, but
  only DSH is wired.
- Cloud sync or multi-user memory.
- Semantic search with embeddings. Keyword search is enough at this scale.

## 2. Data flow

```text
Host session log
   │  session/event
   ▼
Segmenter ── turns ──► Segment { seqRange, tokens, raw blocks }
   │
   ▼  C1 rules
C1 text (tool calls folded, diffs collapsed, retries merged)
   │
   ▼  model
C2 narrative { goal, actions[], result, decisions[], failures[] }
   │
   ▼  model
C3 cards [decision | preference | fact | procedure | failure | entity]
   │
   ▼  fidelity exam (questions → answers → judge)
Card store (DSH storage domain)
   │
   ├──► brief → system prompt
   ├──► recall / read / expand
   └──► N3 decay → age tiers → REM → review queue
```

## 3. Segmentation

Boundaries come from `turn/end` events. Turns are merged until one of:

- accumulated tokens ≥ 500
- three turns have accumulated

A single oversized turn becomes its own segment. Each segment records:

- `seqStart`, `seqEnd`, `turnStart`, `turnEnd`
- `goal` (first user prompt, with runtime-context markers stripped)
- `actions` (deduplicated tool names, max 6)
- `failures` (tool results with `isError`, resolved through `message.source.callId`)
- `raw` blocks (user / assistant / tool-call / tool-result, capped at 400 blocks)

Why strip runtime context? Hosts often append environment banners to the user
message. Left alone, every `goal` becomes "do X. Current runtime context...".

## 4. Compression ladder

| Level | Operation | Reversible via |
|---|---|---|
| C0 | raw events | — |
| C1 | rules: fold tool output, collapse diffs, merge retries, drop acks, redact keys | C0 |
| C2 | narrative JSON | C1 |
| C3 | typed cards | `sources` + `segments` table |
| C4 | one-line brief | card id |

C1 is deterministic and unit-testable. It is the only layer that touches the
original text, so it is where redaction happens.

C2 uses a head/tail window (40% / 60%) when input exceeds 24k characters. A
head-only window was the first version and it produced a confidently wrong
narrative: the conclusion lives at the end of a long turn.

## 5. Card model

```ts
interface MemoryCard {
  id: string
  type: 'decision' | 'preference' | 'fact' | 'procedure' | 'failure' | 'entity' | 'hypothesis'
  status: 'active' | 'pending' | 'archived'
  scope: string                 // session:<id> for now; repo/path/global are future
  title: string
  conclusion: string
  why: string
  how: string
  confidence: number
  salience: number              // server-computed, never model-reported
  weight: number                // decayed every sleep
  lastReplayed: number | null
  sources: { sessionId, seqStart, seqEnd }[]
  createdAt: number
}
```

`salience` is a rule, not a model opinion:

```text
failure 0.80 · decision 0.75 · preference 0.70 · procedure 0.60 · others 0.45
+0.05 if the segment had failures
+0.05 if the segment was debug-like
< 0.45 → discarded
```

## 6. Sleep stages

A sleep run processes the newest unprocessed segments (2 automatic, 3 manual).
For each segment: C2 → C3 → fidelity → merge → mark processed → save C1 text.

After the segment loop, in this order:

1. **Age tiers**
   - delete `segments` older than 7 days (cards stay)
   - archive active cards older than 30 days with `weight < 0.3`
2. **N3 decay** — `weight *= 0.95`; archive below `0.2`
3. **REM** (manual sleep only) — up to 12 active cards, one model call, hypotheses
   enter `pending`
4. **Index rollup** — per scope, once ≥3 archived cards exist, upsert
   `mem_idx_<hash(scope)>` with a summary and the three most recent titles

The order matters. Running decay before age tiers makes 30-day archiving
unreachable for low-weight cards, and the dream report attributes the archive to
the wrong rule.

## 7. Fidelity exam

The gate that decides whether anything is stored.

1. Generate N questions (default 6) from the **durable** narrative: decisions and
   failures only. Open-ended questions are banned.
2. Answer each question using **only the candidate cards**.
3. Judge all answers once, with the narrative available so equivalent answers
   count.

Threshold: `0.95`. Below it the cards are dropped and the report lists the failed
questions with expected and actual answers.

Two calibration lessons:

- Asking about implementation constants (`maxTokens` values, versions) fails a
  semantic memory by design.
- Asking "which conclusion still holds?" is ambiguous; every answer is valid and
  one of them gets marked wrong.

## 8. Storage

A DSH storage domain named `rem`, with `per-record` layout:

| Table | Contents |
|---|---|
| `cards` | memory cards |
| `processed` | segment ids already attempted |
| `segments` | C1 text, capped at 12k chars each, 500 newest kept |
| `reports` | dream reports |

The browser panel never reads the domain directly. The host writes
`<workspace>/.rem/status.json` after every extraction/sleep, and the panel reads
it through DSH's `file` resource + `workspaceFiles.read`, paginated until `eof`.

## 9. Failure modes we hit (and fixed)

These are real incidents, kept because they generalize:

- **Reading an undeclared service** through Cordis's `ctx` proxy throws, and a
  plugin setup error can take the whole host down. Declare it in `inject`, and
  wrap `apply` in a try/catch.
- **Accessing `ctx.remote` without `inject`** in the client half silently
  prevented the sidebar tab from registering, because the try/catch swallowed it.
  Log to `console.error` as well.
- **Truncated JSON** from a small `maxTokens` is indistinguishable from a model
  refusing to answer. `completeJson` retries with double budget when
  `finish === 'max-tokens'`, and includes raw output in the error.
- **A single page** of `workspaceFiles.read` is not the whole file once cards
  grow. Loop on `offset/lines/eof`.
- **Head-only windows** lose the end of long turns, which is exactly where the
  result lives.
- **Order of consolidation steps** changes reported statistics, even when the
  end state is the same.

## 10. Roadmap

- Conflict detection: when two active cards contradict, mark both `disputed`.
- Scope: derive `repo:` / `path:` from the workspace instead of `session:`.
- Cross-harness: adapters for other agent runtimes, sharing the same engine.
- Team sync: git-backed shared storage.
- Benchmark: replay historical tasks with and without memory, compare tokens and
  success rate.

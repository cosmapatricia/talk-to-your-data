# AI Usage

Short and honest, per the brief. This is a living note; I'll add to it as the build
continues.

## Tools

- **Claude (agentic coding assistant)** — used throughout: to pressure-test the plan
  before writing it, scaffold the data pipeline and the DuckDB-WASM loader, author the
  retrieval snippets and golden set, and build the Worker + loop. Most code in this repo
  was written by the agent under my direction.

## What I handed over wholesale

- Boilerplate and glue: the Vite/wrangler config, the DuckDB-WASM bootstrap, the
  `{sql, rationale}` plumbing, the HTML/CSS.
- The first pass of the retrieval snippets and golden-set reference SQL — but *not*
  blindly: the code maps were extracted from the actual DfT data guide with a throwaway
  DuckDB script, and every reference query was run against the committed Parquet before I
  trusted it as an oracle (see `scripts/verify-golden.mjs`).

## What I rejected or rewrote

- **Vector retrieval (Vectorize).** The agent's early instinct was to reach for a vector
  store. I pushed back: at ~20 snippets that fit in the prompt wholesale, that's
  infrastructure for a problem I don't have. We kept retrieval as plain inlining and
  wrote down the threshold at which selection would earn its place.
- **Risk framing.** I kept my own "highest-severity (validator) vs. least-understood
  (semantic correctness)" split rather than collapsing to a single headline risk.

## The agent being confidently wrong — and how I caught it

Two concrete cases, both caught at **runtime**, not review:

1. **A hardcoded model ID that had been deprecated.** The agent set the Workers AI model
   to `@cf/meta/llama-3.1-8b-instruct` with full confidence. That ID was deprecated on
   2026-05-30 — after the model's training cut-off — so it looked correct but wasn't. It
   failed only when I ran the live loop: `5028: ... was deprecated`. Fix: pulled the
   current catalog and switched to `@cf/meta/llama-3.1-8b-instruct-fast`. Lesson: a
   plausible-looking external identifier from an LLM is a guess; verify model/API IDs
   against the live source, don't trust recall.

2. **A parser that assumed the response was a string.** The agent wrote the SQL-response
   parser as `res.response.match(/.../)`, assuming Workers AI returns
   `{ response: string }`. For this model `response` came back as an object, so the first
   real call threw `text.match is not a function`. It type-checked and built fine — the
   wrong assumption was about a runtime shape the types didn't capture. Fix: made the
   parser tolerate every response shape (string, `{response: string}`,
   `{response: {...}}`, or the object directly) and include a snippet of the raw response
   in its error so the next surprise is visible. Lesson: don't assume an external API's
   response shape from one remembered example; handle the variants and surface the raw
   payload on failure.

Both are the same underlying failure mode: the agent is fluent and confident about
external contracts (model IDs, response shapes) it can't actually verify from training,
and those slip past type-checking and builds because they're only wrong at runtime. My
guard against it is to run the real thing early and read the actual errors.

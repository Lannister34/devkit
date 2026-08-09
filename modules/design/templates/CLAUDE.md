## Design before code

Before implementing anything beyond a local edit, state three things:

1. **The seam being touched** — which module owns this change, and what its interface is.
2. **The alternative rejected** — the other plausible shape, and why it loses here.
3. **The failure modes introduced** — the new ways this can break, and where each is handled.

A change that introduces a new external boundary — queue, HTTP client, provider adapter, storage
backend, background job — also states its test strategy and flags any harness that does not exist
yet. Propose the tooling; do not wait to be asked for it.

## ADRs

A decision graduates to `docs/adr/` when it is **expensive to reverse**: a datastore, a transport,
a queue, an inference engine, a boundary between services, a schema-ownership rule. Cheap, local,
easily-undone choices stay in the code.

Format: `docs/adr/NNNN-short-slug.md`, following `0000-template.md`. Record the alternatives that
lost, and name a fallback wherever one exists — the fallback is what makes a risky choice
acceptable.

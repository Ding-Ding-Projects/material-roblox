# Ollama suite manager

## What it is

A complete local model-suite manager speaking **only Ollama's documented local
HTTP API** (`127.0.0.1:11434`) through the privileged process boundary: health,
version, installed/running models, tags, pulls, deletes, copies, generation,
chat, and capability metadata. No unofficial proxy, no embedded cloud service,
no invented sample models.

## Model Store — exhaustive, not curated

Every model in the official catalog and every published variant/tag is
enumerated at each verified refresh, following all pagination, with source
revision, refresh timestamp, page count, completeness verdict, and last success
recorded. Locally installed tags combine with the catalog without hiding either;
offline shows only the last verified catalog plus current local state — never
guessed new entries.

Search/filter/sort across the whole inventory with plain-text default and the
full regex builder; filters include installed/running state, family,
capability, variant, quantization, size, and hardware fit.

## Hardware fit is conservative evidence, never a promise

Current RAM, GPU model, usable VRAM, driver support, free disk, and
architecture combine with exact blob size, parameter count, quantization,
declared context window, and configurable overhead to produce one of:

**Runs well · Runs with limits · Unlikely · Unknown**

The evidence and assumptions sit beside every verdict, timestamped, recomputed
when anything changes. Capability is never inferred from a model name, missing
metadata is never treated as zero, and uncertainty produces *Unknown* or a more
conservative verdict — never a promise that a download will run.

## Cart = batch pull only, never money

Adding a model schedules a local pull. There is no price, purchase, checkout,
account, payment, subscription, or cloud entitlement anywhere in the flow.
Before starting you see each exact tag, download size, conservative disk
requirement, network disclosure, fit verdict, and aggregate estimate; pulls run
with bounded parallelism, durable per-item state, byte-accurate progress,
cancellation, retry, and honest partial outcomes. A failed item never turns the
batch green or deletes a valid installed model.

## Chat & harness launch

Streamed responses, explicit model choice, editable system prompt, documented
parameters with validated defaults, stop/cancel/retry, multi-session history
with search and redacted export. Attachments appear only when the selected
model's verified capabilities support them — otherwise visible but disabled
with the gap named.

Harness launching is **allowlisted orchestration by the app**: prebuilt
profiles plus registration only through real executable pickers and validated
argument/environment schemas — never an arbitrary shell command. Every launch
gets a visible preflight preview (model, executable, arguments, working
directory, environment keys with secrets redacted, ports, fit verdict,
blockers), a snapshot before mutation with one-click restore, and automatic
rollback when launch or health verification fails.

Unavailable states stay useful: browsing, history, profile editing, snapshots,
restore, and bundled help work offline; missing / stopped / unhealthy / offline
each get their own diagnosis plus in-app troubleshooting — never "see online
docs".

## Verification status

Implemented against the documented API surface. Catalog pagination and fit-verdict
tests are ROADMAP Phase 2 work; remote-catalog features wait on official API
availability (tracked in ROADMAP).

## Suggested articles

- [File converter](file-converter.md)
- [Exports](../interface/exports.md)

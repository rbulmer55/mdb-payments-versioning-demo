# UK Benefit Payments — polymorphic collection demo

A small, runnable demo for an audience with a relational background. It ingests a
payment file containing **different UK benefit payments** (Universal Credit and PIP)
into **one MongoDB collection**, enforces the schema in **two places** (TypeScript and
the database), then shows how adding a **third benefit type** (State Pension) takes
minutes rather than a migration project.

Everything runs locally on the [`mongodb/mongodb-atlas-local`](https://hub.docker.com/r/mongodb/mongodb-atlas-local) image.

---

## Run it

```bash
npm install
npm run db:up          # MongoDB Atlas Local on localhost:27020
npm run make:files     # write the inbound payment files (once)
npm run ingest:reset   # ingest every file in data/inbound/
npm start              # dashboard at http://localhost:3000
```

Then, while the dashboard is still running:

```bash
npm run extend         # a whole new benefit type (State Pension), live
npm run upgrade        # an existing benefit type changes shape (UC v1 → v2), live
```

Refresh the browser after each. Neither required a dashboard code change, a backfill,
or any downtime — and the two commands demonstrate the two different ways a real system
has to change:

| Axis of change                             | Command           | What happens                                               |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------- |
| A **new** benefit type appears             | `npm run extend`  | new branch in the `oneOf`, new documents alongside the old |
| An **existing** benefit type changes shape | `npm run upgrade` | UC v1 and UC v2 coexist; PIP and State Pension untouched   |

Either order works, and both are safe to re-run.

---

## The relational comparison

| Relational instinct                                            | What this demo does                         |
| -------------------------------------------------------------- | ------------------------------------------- | --- | ----------------------------------------------------------- | -------------------------------------------------- | --- | ------------------------------ | ------------------------------------- |
| `payments`, `uc_payments`, `pip_payments` + joins              | one `benefitPayments` collection            |
| `uc_elements`, `uc_deductions`, `pip_descriptors` child tables | embedded arrays inside the document         |
| `UNION ALL` across benefit tables for a dashboard              | one `$group` on `benefitType`               |
| 180 nullable columns to fit every benefit into one table       | fields exist only where they apply          |
| `ALTER TABLE` + migration window for a new benefit             | `collMod` — online, existing rows untouched |     | `ALTER TABLE ADD COLUMN NULL` when a benefit's rules change | per-type `schemaVersion`; old and new rows coexist |     | Schema enforced only by the DB | enforced by Zod **and** `$jsonSchema` |

---

## How it fits together

```
data/inbound/                       the payment files, ingested by `npm run ingest`
  payments-2026-06|07|08.ndjson       monthly batches
  payments-2026-08-worked-examples…   the DWP-supplied examples, incl. one bad record
data/new-benefit/                   held back for `npm run extend`
  state-pension-2026-08*.ndjson
data/new-version/                   held back for `npm run upgrade`
  payments-2026-09.ndjson             UC v2 and PIP v1 in the same file

src/shared/      the contract, shared by every layer
  schema.ts        the versioned schemas + (benefitType, schemaVersion) dispatch
  validator.ts     the same contract as MongoDB $jsonSchema, composed per branch
  db.ts            connection and collection handle
src/setup/       one-off data preparation and loading
  generate.ts            batch record factory
  make-payment-files.ts  writes the NDJSON files to disk
  ingest.ts              read files → validate → bulk write → summarise
src/migrations/  schema evolution, ordered by date
  2026-08-add-state-pension.ts    a new benefit type
  2026-09-universal-credit-v2.ts  an existing benefit type changes shape
src/app/         live runtime
  stats.ts         every dashboard figure, from the aggregation framework
  server.ts        tiny Express API
public/index.html  the dashboard
```

Everything on the dashboard comes from files on disk. Nothing is synthesised at request
time, and every document carries its provenance in `ingest.sourceFile`.

### 1. Flexible does not mean uncontrolled

`src/shared/schema.ts` defines a Zod **discriminated union** on `benefitType`. TypeScript then
narrows correctly: ask a PIP payment for `paymentDetails.netPayment` and it will not compile.

`src/shared/validator.ts` expresses the same rules as a MongoDB `$jsonSchema` validator using
`oneOf`: a document must satisfy the shared core **and** exactly one benefit-specific shape.
That one is enforced by the server, so it also protects you from whatever writes to the
database next year that is not this application.

The payment file deliberately contains one record with a malformed sort code. Watch it get
rejected with a readable error, by name and line number, before it reaches MongoDB:

```
   ✅ 7 passed schema validation
   ⛔ 1 rejected before they ever reached MongoDB:
      line 8 (BEN-2026-0849002): paymentDetails.bankAccount.sortCode: Sort code must be NN-NN-NN
```

### 2. One collection, many shapes

A UC document has `elements[]` and `paymentDetails.netPayment`.
A PIP document has `assessment.dailyLivingComponent.descriptors[]` and `paymentDetails.totalPayment`.
They live side by side, share one index set, and are queried together:

```js
{ $group: {
    _id: "$benefitType",
    count: { $sum: 1 },
    totalPaid: { $sum: { $ifNull: ["$paymentDetails.netPayment", "$paymentDetails.totalPayment"] } }
} }
```

Type-specific analytics are just deeper paths — no joins:

```js
{ $match: { benefitType: "Universal Credit" } },
{ $unwind: "$elements" },
{ $group: { _id: "$elements.elementType", total: { $sum: "$elements.amount" } } }
```

### 3. Agility, demonstrated rather than claimed

`npm run extend` does four things in order:

1. Tries to insert a State Pension payment — **MongoDB refuses it**: the current contract
   does not include that branch.
2. Runs `collMod` to add the branch. Online. Existing documents are not read or rewritten.
3. Ingests the new benefit type into the same collection.
4. Re-runs the dashboard aggregation, which now returns three benefit types.

The dashboard picks it up on refresh with no code change, because it never assumed how many
benefit types there were.

**Migrations are additive and order-independent.** Each one reads the branches the collection
currently accepts and adds its own, rather than replacing the validator with a fixed snapshot:

```ts
const { added, titles } = await enableBranch(db, COLLECTION_NAME, "State Pension v1");
```

So `extend` then `upgrade`, or `upgrade` then `extend`, both converge on the same four-branch
contract — and re-running either is a no-op that reports `Contract unchanged`. That matters
beyond the demo: real migrations land in whatever order the release train allows, and a
migration that assumes its predecessors have already run will silently revoke their changes.

### 4. Versioning an existing benefit type

New benefit types are the easy case. The harder one is an existing type changing shape —
in relational terms, the `ALTER TABLE ADD COLUMN NULL` that never gets cleaned up.

Every document carries a `schemaVersion`, and **each benefit type versions independently**:

```ts
export const CURRENT_SCHEMA_VERSION = {
  "Universal Credit": 2, // bumped by the 2026 earnings-taper change
  "Personal Independence Payment": 1, // unaffected
  "State Pension": 1, // unaffected
} as const satisfies Record<BenefitType, number>;
```

`npm run upgrade` moves Universal Credit to v2 — deductions must now cite a
`recoveryReference`, and the `earnedIncome` behind the taper is recorded. It follows the same
four steps: the database **rejects** a v2 document under the current contract, `collMod`
applies a validator whose `oneOf` accepts _both_ UC shapes, then the September file is
ingested. Afterwards:

| Benefit type                  | Version | Documents |
| ----------------------------- | ------- | --------- |
| Universal Credit              | v1      | 1,483     |
| Universal Credit              | v2      | 448       |
| Personal Independence Payment | v1      | 1,026     |
| State Pension                 | v1      | 343       |

Nothing was backfilled. The 1,483 v1 documents were never read, let alone rewritten, and
`oneOf` still means exactly one branch may match — so a document cannot be ambiguously
versioned. Retiring v1 becomes an optional background task rather than a release blocker.

Two conventions make this safe:

- **`schemaVersion` is optional and defaults to 1.** Documents written before versioning
  existed stay valid. A versioning scheme that needs a migration to introduce has rather
  missed the point.
- **Never reuse a field name with a different meaning.** Add a new field instead. Reading
  code then dispatches on `(benefitType, schemaVersion)` — see `BenefitPaymentSchema` in
  `src/shared/schema.ts`, which resolves the pair to a concrete schema so validation errors
  still point at the real field rather than "no union member matched".

---

## Phasing out Universal Credit v1

**Not implemented — this is the operational playbook that follows `npm run upgrade`.**

Start with the question people skip: **does v1 need to go at all?** Supporting two versions
costs one extra branch in `VERSIONED_SCHEMAS` and one extra branch in the validator's
`oneOf`. That is genuinely cheap, and for payment records — which are legal evidence of what
was paid, when, and on what basis — rewriting history is often the _wrong_ answer.

Retire v1 when the cost is real: the v1 branch blocks a change you need, the two shapes are
causing bugs, or an index or query has to special-case the difference. Retire it because it
hurts, not because mixed versions feel untidy.

If you do retire it, there are three mechanisms, and the choice is not either/or — the mature
answer usually combines them.

### 1. Upgrade-on-read (lazy)

Reading code converts v1 to the v2 shape in memory; nothing is written unless the document
happens to be updated anyway.

```
read → if schemaVersion < 2 → upgrade in memory → hand v2 to the caller
```

**Use it for:** the transition period, always. Even if you also run a batch, this is what makes
the batch safe to run slowly and lets you deploy v2-only application logic on day one.

- **Pros.** Zero write load. Zero migration window. Naturally incremental — hot documents
  convert first, cold ones never cost anything. Trivially reversible: delete the upgrade
  function and you are back to v1 handling.
- **Cons.** It never finishes on its own, so v1 support code lives forever unless something
  else completes the job. Adds a small cost to every read. Most importantly, **`$jsonSchema`
  and the aggregation pipeline never see the upgraded shape** — only your application does.
  So `src/app/stats.ts` still needs `$ifNull` handling, and the database validator must still
  accept v1.

That last point is the one that catches people. Upgrade-on-read fixes application code, not
analytics. In this codebase the fix belongs in one place — `BenefitPaymentSchema` — so callers
only ever see the latest shape.

### 2. Background batch conversion

A throttled job walks v1 documents and rewrites them as v2.

```js
{ benefitType: "Universal Credit", schemaVersion: { $in: [1, null] } }
```

That filter is served by an index on `{ benefitType: 1, schemaVersion: 1 }`, and the remaining
count is your progress bar — the job is resumable by construction, because converted documents
leave the result set.

**Use it for:** actually finishing, so the v1 branch can be deleted.

- **Pros.** Terminates. Once the count reaches zero you can drop the v1 schema, tighten the
  validator to v2-only, and delete the upgrade-on-read path.
- **Cons.** Real write load — every converted document is a new version in the oplog, replicated
  to secondaries and to any change stream consumer. At scale that is the dominant cost, not the
  reads.

Practical constraints:

- **Throttle it.** Small batches with a pause between them. A migration that saturates the oplog
  or the cache is indistinguishable from an outage.
- **Backfilled fields must be honest.** v2 requires `earnedIncome` and a `recoveryReference` per
  deduction. For a historical payment those values may simply not exist. Inventing zeros
  fabricates financial data. Either derive them from the original source file, or mark them
  explicitly (`"derived": true`) so nobody mistakes a backfill for an assessment.
- **Keep the validator permissive until it is done.** Tighten `oneOf` to v2-only _after_ the
  count reaches zero, never before.
- **Idempotent by design.** Re-running must be safe; the filter guarantees it.

If the honest answer is "those values do not exist for historical payments", that is a strong
signal to stop and leave v1 alone.

### 3. Archival

Move v1 documents out of the operational collection entirely, rather than converting them.

**Use it for:** when v1 documents are old enough that they are no longer operationally queried
— which for benefit payments correlates almost exactly with the version boundary, because a
shape change usually accompanies a policy change with a date.

- **Pros.** No rewriting, no fabricated fields, and the audit trail is preserved exactly as
  paid. The live collection shrinks, which helps every query. Atlas Online Archive keeps the
  data queryable via federated queries.
- **Cons.** Cross-tier queries are slower, so anything spanning the boundary pays for it. The
  reporting rollup must cover both tiers or be frozen for archived periods — which is what
  sealed buckets already do (see the production section above).

### Choosing

| Situation                                    | Approach                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| Transition period, any scale                 | **Upgrade-on-read** — start here, always              |
| Small collection, values genuinely derivable | Batch convert, then delete the v1 branch              |
| Large collection, v1 records are historical  | **Archive**, do not convert                           |
| v2 fields cannot be honestly derived         | Keep v1 — this is a legitimate permanent answer       |
| 500M documents                               | Archive; a full rewrite is an outage with extra steps |

The recommended sequence: deploy **upgrade-on-read** immediately so application code is
version-free from day one, let it absorb the hot documents, then decide — once you can see how
much v1 actually remains — whether the residue is worth a throttled batch or belongs in an
archive. Delete the v1 branch only when the count is zero and stays zero.

---

## API

| Endpoint                                  | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `GET /api/stats`                          | every dashboard figure, from one `$facet` aggregation |
| `GET /api/payments?benefitType=…&limit=…` | sample raw documents                                  |
| `GET /api/validator`                      | the live `$jsonSchema` read back from the collection  |

---

## Keeping the stats current at production scale

**None of the following is implemented here.** The demo deliberately runs the live
aggregation on every request, because the pipeline in `src/app/stats.ts` maps visibly onto the
charts and that makes it a better teaching artefact. This section is what you would do
instead if this were real, and it is worth reading before anyone asks in the room.

### Why the demo approach does not survive contact with production

`GET /api/stats` runs one `$facet` with nothing before it, so:

- **It is a full collection scan on every request.** `$facet` sub-pipelines cannot use indexes
  — only stages _before_ the `$facet` can. Every index created in `src/setup/ingest.ts` is
  unused by the dashboard.
- **One scan, not ten** — that part is correct. All ten sub-pipelines see a single pass over
  the data. Ten separate queries would be ten scans, so the shape is right for on-demand.
  On-demand is the problem, not `$facet`.
- **`$addToSet` breaks first.** `households: { $addToSet: "$claimantId" }` materialises every
  distinct claimant in one `$group`. Trivial at demo scale, exceeds the 100MB group limit at
  production scale.
- **Concurrency makes it worse than slow.** Hundreds of dashboard users each trigger a full
  scan, pulling the whole collection through the WiredTiger cache and evicting the working set
  that ingestion and claimant lookups depend on. Reporting degrades the payment system.

Prove it live rather than asserting it:

```js
db.benefitPayments.explain("executionStats").aggregate([
  /* the /api/stats pipeline */
]);
```

`COLLSCAN` and `totalDocsExamined` equal to the collection count are more persuasive than a
slide.

### The production shape

**1. Cache the response.** A 30–60 second TTL collapses hundreds of concurrent users into one
query per minute. Highest value for the least code, and a payment statistics dashboard does
not need sub-second freshness. Do this before anything else, and keep doing it even after the
rollup exists — they solve different problems.

**2. Roll up into a summary collection.** Aggregate into `paymentStats`, keyed by a **bounded**
bucket such as `{ month, benefitType, status, city }` — roughly 500 documents, versus millions
of payments. `/api/stats` then reads a few hundred small documents and reshapes them for the
charts: indexed, single-digit milliseconds, and **decoupled from payment volume entirely**.
Ten million payments cost the same as ten thousand.

Keep the bucket key bounded. Add `claimantId` or `postcode` and you have recreated the
original collection with extra steps.

**3. Have ingest emit its own rollup.** The obvious trigger is a change stream, but for this
domain it is the wrong tool. `src/setup/ingest.ts` already knows exactly which documents it
just wrote, so it can emit that batch's contribution in the same run, keyed by
`ingest.sourceFile`. No change stream pre-images, no watermark skew, no at-least-once
redelivery to de-duplicate — and it is naturally idempotent, because re-ingesting a file can
replace that file's contribution rather than increment it.

A scheduled trigger doing a windowed `$merge` is the fallback if writes arrive from systems
you do not control. A per-document change stream trigger is the option to avoid: a 910-record
file becomes 910 invocations.

### The parts that are not additive

This is where incremental rollups usually go wrong.

| Metric                  | Incremental treatment                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `count`, `totalPaid`    | `$inc` — genuinely additive                                              |
| `avgPayment`            | **Never store an average.** Store `sum` and `count`, divide on read      |
| `maxPayment`            | Max-of-maxes works for inserts; unrecoverable on delete without a rescan |
| `households` (distinct) | **No incremental form.** Distinct counts cannot be merged                |

Distinct households is bounded by _population_, not payments — the UK has on the order of
20 million claimants however many payments you issue. Upsert a claimant collection at ingest
and count that. Do not try to derive it from the payment collection.

Also note that `$inc` is only correct for inserts. The moment a payment is amended
(`Pending → Paid`, or a corrected `netPayment`) the document moves between buckets and the old
one must be decremented, which requires change stream pre-images. Simpler and cheaper: rebuild
the affected month bucket outright — one month is an indexed range scan.

### Self-healing

Run incremental for freshness and a **periodic full rebuild for correctness**, replacing
buckets outright. The rebuild silently corrects double counts, documents missed to watermark
skew, and drift from amendments. This is what makes it safe for the incremental path to be
occasionally wrong, and it is standard practice in every incremental-aggregation system.

Keep the live `$facet` pipeline behind a flag as the reference implementation — you need it to
verify the rollup has not drifted.

### At 500 million payments

The read path and the incremental path still hold: both are decoupled from collection size.
**The full rebuild is what breaks.** These documents carry `auditTrail`, `descriptors`,
`dependents` and `elements`, so 500M of them is on the order of 1–2TB of scan — hours of
largely serial I/O per shard, and it evicts the entire cache while it runs.

What changes:

- **Seal closed buckets.** A Universal Credit payment from two years ago will not change. Once
  a month closes and the correction window expires (say 90 days for amendments, appeals and
  overpayment recovery), mark the bucket final and never recompute it. The rebuild then covers
  only the open window — tens of millions of documents, not 500 million. This single
  assumption is what makes the whole architecture scale, and it holds because benefit payments
  are immutable after settlement.
- **Consider a slim summary collection.** If full-history recompute must stay possible, have
  ingest also write a minimal projection (`benefitType`, `status`, `paymentMonth`, `city`,
  `amount`, `claimantId`). At ~150 bytes that is ~75GB rather than 1–2TB, and scans in minutes.
- **Shard, carefully.** The rollup then runs in parallel per shard. Hashed `claimantId`
  distributes evenly and keeps claimant lookups targeted; sharding on `paymentDate` alone gives
  you a hot shard on every ingest, because all writes land in the current month.
- **Cluster on payment date** so a month-window rebuild is contiguous I/O rather than scattered
  reads.
- **Archive cold history** (e.g. Atlas Online Archive) to keep the operational collection at
  hot size, with federated queries for long-range analysis.

| Component                    | 500M documents                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `/api/stats` read            | Fine — cost tied to bucket cardinality, not payment count          |
| Per-batch incremental rollup | Fine — cost tied to batch size                                     |
| Full rebuild as described    | **Not viable — bound it with rotating windows and sealed buckets** |
| Distinct households          | Move to a claimant collection; do not derive it                    |

### The honest framing for a relational audience

Nobody runs ten `GROUP BY`s across a fact table on every page load in Oracle either — they
build a materialised view and refresh it. `$merge` into a rollup collection **is** the
materialised view, and the reasoning is identical.

What the document model changes is the maintenance cost: the rollup is one pipeline over one
collection, rather than a `UNION ALL` across three benefit tables that must be rewritten every
time a new benefit launches. The `$ifNull` amount expression and the `oneOf` validator already
absorbed State Pension without edit.

---

## Notes

- The container publishes **27020** on the host to avoid clashing with a locally installed
  mongod on 27017–27019. Override with `MONGODB_URI` if you prefer.
- To browse the data in Compass, use `mongodb://localhost:27020/?directConnection=true`.
  Without `directConnection` the driver tries to resolve the replica set member's advertised
  hostname (`dwp-atlas-local`), which does not exist outside the container.
- Storage is intentionally ephemeral — `npm run ingest:reset` rebuilds everything in seconds.
- All claimant data is fictional.

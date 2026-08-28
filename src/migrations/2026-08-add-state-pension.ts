/**
 * "But what happens when the government launches a new benefit?"
 *
 * Relational answer:  new table (or 12 new nullable columns), a migration
 *                     window, ORM changes, and a regression test of everything.
 * MongoDB answer:     this file. Run it while the API keeps serving traffic.
 *
 * Independent of `npm run upgrade` — either order works, because this adds a
 * branch to the contract rather than replacing it.
 *
 *   npm run extend
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeDb, getDb, COLLECTION_NAME } from "../shared/db.js";
import { BenefitPaymentSchema, type StoredPayment } from "../shared/schema.js";
import { enableBranch } from "../shared/validator.js";

const BRANCH = "State Pension v1";
const DIR = resolve("data/new-benefit");

async function main() {
  const db = await getDb();
  const coll = db.collection<StoredPayment>(COLLECTION_NAME);

  const ingestedAt = new Date();
  const files = (await readdir(DIR))
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
  const docs: StoredPayment[] = [];
  for (const file of files) {
    const lines = (await readFile(join(DIR, file), "utf8"))
      .split("\n")
      .filter((l) => l.trim());
    lines.forEach((line, i) => {
      docs.push({
        ...BenefitPaymentSchema.parse(JSON.parse(line)),
        ingest: { sourceFile: file, fileRecordNumber: i + 1, ingestedAt },
      });
    });
  }

  console.log(
    `📄 ${docs.length} State Pension payments read from ${files.length} file(s) and validated in TypeScript`,
  );

  /* Step 1 — show the database refusing a shape its contract does not include. */
  const probe = docs[0]!;
  try {
    await coll.insertOne(probe);
    console.log(`ℹ️  Collection already accepts "${BRANCH}" — this migration has run before`);
  } catch {
    console.log(`⛔ Database rejected it: the current contract does not include "${BRANCH}".`);
    console.log("   Nothing was corrupted. Flexible ≠ uncontrolled.\n");
  }

  /* Step 2 — add the branch to whatever is already there. Online. */
  const { added, titles } = await enableBranch(db, COLLECTION_NAME, BRANCH);
  console.log(
    added
      ? `📐 collMod applied — contract now accepts: ${titles.join(", ")}`
      : `📐 Contract unchanged — already accepts: ${titles.join(", ")}`,
  );
  console.log("   No existing document was touched, read, or rewritten.\n");

  /* Step 3 — ingest the new benefit type into the SAME collection. */
  const res = await coll.bulkWrite(
    docs.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })),
    { ordered: false },
  );
  console.log(
    `💾 Ingested ${res.upsertedCount + res.modifiedCount + res.matchedCount} State Pension payments`,
  );

  /* Step 4 — the existing dashboard query needs no change at all. */
  const breakdown = await coll
    .aggregate([
      {
        $group: {
          _id: "$benefitType",
          count: { $sum: 1 },
          totalPaid: {
            $sum: {
              $ifNull: [
                "$paymentDetails.netPayment",
                "$paymentDetails.totalPayment",
              ],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  console.table(
    breakdown.map((b) => ({
      benefitType: b._id,
      documents: b.count,
      totalPaid: `£${b.totalPaid.toFixed(2)}`,
    })),
  );
  console.log(
    "↻ Refresh the dashboard — the new benefit type is already there.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);

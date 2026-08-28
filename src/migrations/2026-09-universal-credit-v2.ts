/**
 * "The benefit itself changed. Do we need a new table, or a nullable column?"
 *
 * Neither. Universal Credit moves to v2 — deductions must now cite a recovery
 * reference, and the earned income behind the taper is recorded. PIP and State
 * Pension are untouched, and every existing UC v1 document is left exactly as it
 * is. Both versions are legal in the collection at the same time.
 *
 * Independent of `npm run extend` — either order works, because this adds a
 * branch to the contract rather than replacing it.
 *
 *   npm run upgrade
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeDb, getDb, COLLECTION_NAME } from "../shared/db.js";
import { BenefitPaymentSchema, type StoredPayment } from "../shared/schema.js";
import { enableBranch } from "../shared/validator.js";

const BRANCH = "Universal Credit v2";
const DIR = resolve("data/new-version");

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

  const v2Count = docs.filter(
    (d) => d.benefitType === "Universal Credit",
  ).length;
  console.log(
    `📄 ${docs.length} payments read from ${files.length} file(s) — ${v2Count} are Universal Credit v2`,
  );

  /* Step 1 — the database refuses a shape its contract does not include. */
  const probe = docs.find((d) => d.benefitType === "Universal Credit")!;
  try {
    await coll.insertOne(probe);
    console.log(`ℹ️  Collection already accepts "${BRANCH}" — this migration has run before`);
  } catch {
    console.log(`⛔ Database rejected it: the current contract does not include "${BRANCH}".`);
    console.log("   A shape change is still a deliberate, reviewed act.\n");
  }

  /* Step 2 — add the v2 branch alongside v1. Online. */
  const { added, titles } = await enableBranch(db, COLLECTION_NAME, BRANCH);
  console.log(
    added
      ? `📐 collMod applied — contract now accepts: ${titles.join(", ")}`
      : `📐 Contract unchanged — already accepts: ${titles.join(", ")}`,
  );
  console.log(
    "   No backfill. No downtime. Existing v1 documents were not read or rewritten.\n",
  );

  /* Step 3 — ingest the new version alongside the old. */
  const res = await coll.bulkWrite(
    docs.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })),
    { ordered: false },
  );
  console.log(
    `💾 Ingested ${res.upsertedCount + res.modifiedCount + res.matchedCount} payments`,
  );

  /* Step 4 — both versions, side by side, queried by one unchanged pipeline. */
  const versions = await coll
    .aggregate([
      {
        $group: {
          _id: {
            benefitType: "$benefitType",
            schemaVersion: { $ifNull: ["$schemaVersion", 1] },
          },
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
      { $sort: { "_id.benefitType": 1, "_id.schemaVersion": 1 } },
    ])
    .toArray();

  console.table(
    versions.map((v) => ({
      benefitType: v._id.benefitType,
      schemaVersion: `v${v._id.schemaVersion}`,
      documents: v.count,
      totalPaid: `£${v.totalPaid.toFixed(2)}`,
    })),
  );
  console.log(
    "↻ Refresh the dashboard — both Universal Credit versions are reported side by side.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);

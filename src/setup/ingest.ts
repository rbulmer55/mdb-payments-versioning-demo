/**
 * Ingest the inbound UK benefit payment files (NDJSON) into a single
 * polymorphic collection. Everything the dashboard shows comes from here.
 *
 *   npm run ingest            # append
 *   npm run ingest:reset      # drop + recreate + ingest
 *
 * Options: --dir=<path> --drop
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MongoBulkWriteError } from "mongodb";
import { closeDb, getDb, COLLECTION_NAME } from "../shared/db.js";
import { BenefitPaymentSchema, type StoredPayment } from "../shared/schema.js";
import { validatorV1 } from "../shared/validator.js";

const args = process.argv.slice(2);
const inboundDir = resolve(
  args.find((a) => a.startsWith("--dir="))?.split("=")[1] ?? "data/inbound",
);
const drop = args.includes("--drop");

interface FileResult {
  file: string;
  read: number;
  accepted: number;
  rejected: { line: number; id: unknown; errors: string[] }[];
}

async function readBatchFile(
  path: string,
): Promise<{ docs: StoredPayment[]; result: FileResult }> {
  const sourceFile = basename(path);
  const ingestedAt = new Date();
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const docs: StoredPayment[] = [];
  const rejected: FileResult["rejected"] = [];

  lines.forEach((line, i) => {
    const raw: unknown = JSON.parse(line);
    const parsed = BenefitPaymentSchema.safeParse(raw);
    if (parsed.success) {
      docs.push({
        ...parsed.data,
        ingest: { sourceFile, fileRecordNumber: i + 1, ingestedAt },
      });
    } else {
      rejected.push({
        line: i + 1,
        id: (raw as { _id?: unknown })._id,
        errors: parsed.error.issues.map(
          (e) => `${e.path.join(".")}: ${e.message}`,
        ),
      });
    }
  });

  return {
    docs,
    result: {
      file: sourceFile,
      read: lines.length,
      accepted: docs.length,
      rejected,
    },
  };
}

async function main() {
  const db = await getDb();

  if (drop) {
    await db
      .collection(COLLECTION_NAME)
      .drop()
      .catch(() => {});
    console.log(`🗑  Dropped ${COLLECTION_NAME}`);
  }

  // Server-side contract. Applied at create time, changeable later with collMod.
  const exists = await db.listCollections({ name: COLLECTION_NAME }).hasNext();
  if (!exists) {
    await db.createCollection(COLLECTION_NAME, {
      validator: validatorV1,
      validationLevel: "strict",
      validationAction: "error",
    });
    console.log(
      `📐 Created ${COLLECTION_NAME} accepting: Universal Credit v1, Personal Independence Payment v1`,
    );
  }

  const coll = db.collection<StoredPayment>(COLLECTION_NAME);

  // One collection, one set of indexes, serving every benefit type.
  await coll.createIndexes([
    {
      key: { benefitType: 1, "paymentDetails.paymentDate": -1 },
      name: "type_date",
    },
    { key: { claimantId: 1 }, name: "claimant" },
    { key: { status: 1 }, name: "status" },
    { key: { "personalDetails.address.city": 1 }, name: "city" },
    { key: { "ingest.sourceFile": 1 }, name: "source_file" },
    // Sparse-by-nature: only UC documents have `elements`, only PIP has `assessment`.
    { key: { "elements.elementType": 1 }, name: "uc_elements", sparse: true },
    {
      key: { "assessment.dailyLivingComponent.rate": 1 },
      name: "pip_dl_rate",
      sparse: true,
    },
  ]);

  const files = (await readdir(inboundDir))
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
  if (files.length === 0) {
    console.log(
      `No .ndjson files in ${inboundDir} — run \`npm run make:files\` first.`,
    );
    return;
  }

  console.log(`\n📂 ${inboundDir}`);
  const results: FileResult[] = [];

  for (const file of files) {
    const { docs, result } = await readBatchFile(join(inboundDir, file));
    results.push(result);

    console.log(
      `\n📄 ${file}: ${result.read} read, ${result.accepted} passed TypeScript validation`,
    );
    if (result.rejected.length) {
      console.log(
        `   ⛔ ${result.rejected.length} rejected before they ever reached MongoDB:`,
      );
      for (const r of result.rejected)
        console.log(`      line ${r.line} (${r.id}): ${r.errors.join("; ")}`);
    }
    if (docs.length === 0) continue;

    try {
      const res = await coll.bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false },
      );
      console.log(
        `   💾 ${res.upsertedCount + res.modifiedCount + res.matchedCount} documents written`,
      );
    } catch (err) {
      if (err instanceof MongoBulkWriteError) {
        const writeErrors = [err.writeErrors ?? []].flat();
        console.error(
          `   ⚠️  ${writeErrors.length} documents rejected by the database validator`,
        );
        for (const e of writeErrors.slice(0, 3))
          console.error(JSON.stringify(e.err?.errInfo, null, 2));
      } else throw err;
    }
  }

  console.log("\n📥 Files ingested:");
  console.table(
    results.map((r) => ({
      file: r.file,
      read: r.read,
      accepted: r.accepted,
      rejected: r.rejected.length,
    })),
  );

  // One query, every benefit type — the same expression the dashboard uses.
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

  console.log("\n📊 Collection contents (single query, every benefit type):");
  console.table(
    breakdown.map((b) => ({
      benefitType: b._id,
      documents: b.count,
      totalPaid: `£${b.totalPaid.toFixed(2)}`,
    })),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);

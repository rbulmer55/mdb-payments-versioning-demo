/**
 * Writes the monthly inbound batch files. Run once (or after changing volumes):
 *
 *   npm run make:files
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateBatch, generateStatePensionBatch } from "./generate.js";

const INBOUND = resolve("data/inbound");
const NEW_BENEFIT = resolve("data/new-benefit");
const NEW_VERSION = resolve("data/new-version");

const BATCHES = [
  { month: 6, count: 620, ucShare: 0.6 },
  { month: 7, count: 780, ucShare: 0.63 },
  { month: 8, count: 910, ucShare: 0.65 },
];

async function main() {
  await mkdir(INBOUND, { recursive: true });
  for (const batch of BATCHES) {
    const name = `payments-2026-${String(batch.month).padStart(2, "0")}.ndjson`;
    const records = generateBatch(batch);
    await writeFile(
      join(INBOUND, name),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    console.log(`📝 ${name.padEnd(28)} ${records.length} records`);
  }

  await mkdir(NEW_BENEFIT, { recursive: true });
  const pensions = generateStatePensionBatch({ month: 8, count: 340 });
  await writeFile(
    join(NEW_BENEFIT, "state-pension-2026-08.ndjson"),
    pensions.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  console.log(
    `\n📝 new-benefit/state-pension-2026-08.ndjson ${pensions.length} records (held back for \`npm run extend\`)`,
  );

  // September onwards: Universal Credit switches to v2, PIP stays on v1 in the
  // same file — which is exactly the mixed-version state production lives in.
  await mkdir(NEW_VERSION, { recursive: true });
  const september = generateBatch({
    month: 9,
    count: 640,
    ucShare: 0.7,
    ucVersion: 2,
  });
  await writeFile(
    join(NEW_VERSION, "payments-2026-09.ndjson"),
    september.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const ucCount = september.filter(
    (r) => r.benefitType === "Universal Credit",
  ).length;
  console.log(
    `📝 new-version/payments-2026-09.ndjson       ${september.length} records ` +
      `(${ucCount} UC v2, held back for \`npm run upgrade\`)`,
  );

  console.log("\nRun `npm run ingest:reset` to load them.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

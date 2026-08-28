import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, COLLECTION_NAME, DB_NAME } from "../shared/db.js";
import { getStats, getSamplePayments } from "./stats.js";
import { BENEFIT_TYPES } from "../shared/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.static(join(__dirname, "..", "..", "public")));

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to compute statistics" });
  }
});

app.get("/api/payments", async (req, res) => {
  // Whitelist the discriminator: never pass raw query values into a filter.
  const requested =
    typeof req.query.benefitType === "string"
      ? req.query.benefitType
      : undefined;
  const benefitType = BENEFIT_TYPES.find((t) => t === requested);
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
  const version = Number(req.query.schemaVersion);
  const schemaVersion =
    Number.isInteger(version) && version > 0 ? version : undefined;
  try {
    res.json(await getSamplePayments(benefitType, limit, schemaVersion));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

/** The live, server-enforced contract — read straight back out of MongoDB. */
app.get("/api/validator", async (_req, res) => {
  try {
    const db = await getDb();
    const [info] = await db
      .listCollections({ name: COLLECTION_NAME }, { nameOnly: false })
      .toArray();
    res.json(
      info?.options?.validator ?? {
        note: "No validator applied yet — run `npm run ingest`.",
      },
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read collection validator" });
  }
});

app.listen(PORT, () => {
  console.log(`\n🖥  DWP payment dashboard  →  http://localhost:${PORT}`);
  console.log(`   database: ${DB_NAME}.${COLLECTION_NAME}\n`);
});

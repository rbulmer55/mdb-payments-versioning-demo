/**
 * Second line of defence: the same contract, expressed as a MongoDB
 * `$jsonSchema` validator on the collection itself.
 *
 * Zod protects the *application*. This protects the *database* — including
 * from the Python script somebody writes next week that bypasses your API.
 *
 * `oneOf` gives us true polymorphic validation: a document must satisfy the
 * shared core AND exactly one of the benefit-specific shapes.
 */
import type { Db, Document } from "mongodb";

const money = { bsonType: ["double", "int", "long", "decimal"], minimum: 0 };

const address = {
  bsonType: "object",
  required: ["line1", "city", "postcode"],
  properties: {
    line1: { bsonType: "string" },
    line2: { bsonType: "string" },
    city: { bsonType: "string" },
    postcode: {
      bsonType: "string",
      pattern: "^[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}$",
    },
  },
};

const bankAccount = {
  bsonType: "object",
  required: ["sortCode", "accountNumberLast4"],
  properties: {
    sortCode: { bsonType: "string", pattern: "^[0-9]{2}-[0-9]{2}-[0-9]{2}$" },
    accountNumberLast4: { bsonType: "string", pattern: "^[0-9]{4}$" },
  },
};

/** Rules that apply to every benefit payment, whatever its shape. */
const core = {
  bsonType: "object",
  required: [
    "_id",
    "claimantId",
    "benefitType",
    "claimReference",
    "personalDetails",
    "paymentDetails",
    "status",
    "auditTrail",
  ],
  properties: {
    _id: { bsonType: "string", pattern: "^BEN-[0-9]{4}-[0-9]{7}$" },
    claimantId: { bsonType: "string", pattern: "^NIN-[A-Z]{2}[0-9]{6}[A-D]$" },
    benefitType: {
      enum: [
        "Universal Credit",
        "Personal Independence Payment",
        "State Pension",
      ],
    },
    claimReference: { bsonType: "string" },
    status: { enum: ["Paid", "Pending", "Held", "Cancelled", "Failed"] },
    // Not required: documents written before versioning existed are treated as v1.
    schemaVersion: { bsonType: ["int", "long"], minimum: 1 },
    personalDetails: {
      bsonType: "object",
      required: ["firstName", "lastName", "dateOfBirth", "address"],
      properties: {
        firstName: { bsonType: "string" },
        lastName: { bsonType: "string" },
        dateOfBirth: { bsonType: "string" },
        address: address,
      },
    },
    auditTrail: {
      bsonType: "array",
      minItems: 1,
      items: {
        bsonType: "object",
        required: ["event", "timestamp", "actor"],
        properties: {
          event: { bsonType: "string" },
          timestamp: { bsonType: "string" },
          actor: { bsonType: "string" },
        },
      },
    },
    ingest: {
      bsonType: "object",
      required: ["sourceFile", "fileRecordNumber", "ingestedAt"],
      properties: {
        sourceFile: { bsonType: "string" },
        fileRecordNumber: { bsonType: ["int", "long"], minimum: 1 },
        ingestedAt: { bsonType: "date" },
      },
    },
  },
};

/** Universal Credit v1: gross - deductions = net, split across "elements". */
const universalCreditV1 = {
  title: "Universal Credit v1",
  bsonType: "object",
  required: ["elements"],
  properties: {
    benefitType: { enum: ["Universal Credit"] },
    // Absent counts as v1, so legacy documents still match this branch.
    schemaVersion: { enum: [1] },
    paymentDetails: {
      bsonType: "object",
      required: [
        "paymentDate",
        "paymentMethod",
        "grossEntitlement",
        "netPayment",
      ],
      properties: {
        paymentDate: { bsonType: "string" },
        paymentMethod: { enum: ["BACS", "Faster Payments", "Cheque"] },
        bankAccount: bankAccount,
        grossEntitlement: money,
        netPayment: money,
        deductions: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["type", "amount"],
            properties: { type: { bsonType: "string" }, amount: money },
          },
        },
      },
    },
    elements: {
      bsonType: "array",
      minItems: 1,
      items: {
        bsonType: "object",
        required: ["elementType", "amount"],
        properties: {
          elementType: { bsonType: "string" },
          amount: money,
          childrenCovered: { bsonType: ["int", "long"], minimum: 0 },
        },
      },
    },
  },
};

/**
 * Universal Credit v2: deductions must cite a recovery reference, and the
 * earned income behind the taper calculation is recorded.
 */
const universalCreditV2 = {
  title: "Universal Credit v2",
  bsonType: "object",
  required: ["schemaVersion", "elements", "earnedIncome"],
  properties: {
    benefitType: { enum: ["Universal Credit"] },
    schemaVersion: { enum: [2] },
    paymentDetails: {
      bsonType: "object",
      required: [
        "paymentDate",
        "paymentMethod",
        "grossEntitlement",
        "netPayment",
      ],
      properties: {
        paymentDate: { bsonType: "string" },
        paymentMethod: { enum: ["BACS", "Faster Payments", "Cheque"] },
        bankAccount: bankAccount,
        grossEntitlement: money,
        netPayment: money,
        deductions: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["type", "amount", "recoveryReference"],
            properties: {
              type: { bsonType: "string" },
              amount: money,
              recoveryReference: {
                bsonType: "string",
                pattern: "^REC-[0-9]{8}$",
              },
            },
          },
        },
      },
    },
    elements: {
      bsonType: "array",
      minItems: 1,
      items: {
        bsonType: "object",
        required: ["elementType", "amount"],
        properties: {
          elementType: { bsonType: "string" },
          amount: money,
          childrenCovered: { bsonType: ["int", "long"], minimum: 0 },
        },
      },
    },
    earnedIncome: {
      bsonType: "object",
      required: ["monthlyEarnings", "workAllowanceApplied", "taperDeduction"],
      properties: {
        monthlyEarnings: money,
        workAllowanceApplied: money,
        taperDeduction: money,
      },
    },
  },
};

/** PIP: points-based assessment across two components. */
const pip = {
  title: "Personal Independence Payment v1",
  bsonType: "object",
  required: ["assessment"],
  properties: {
    benefitType: { enum: ["Personal Independence Payment"] },
    assessment: {
      bsonType: "object",
      required: [
        "assessmentDate",
        "assessmentProvider",
        "dailyLivingComponent",
        "mobilityComponent",
      ],
      properties: {
        assessmentDate: { bsonType: "string" },
        assessmentProvider: { bsonType: "string" },
        dailyLivingComponent: pipComponent(),
        mobilityComponent: pipComponent(),
      },
    },
    paymentDetails: {
      bsonType: "object",
      required: [
        "paymentDate",
        "paymentMethod",
        "dailyLivingAmount",
        "mobilityAmount",
        "totalPayment",
      ],
      properties: {
        paymentDate: { bsonType: "string" },
        paymentFrequency: { enum: ["Weekly", "4-weekly", "Monthly"] },
        paymentMethod: { enum: ["BACS", "Faster Payments", "Cheque"] },
        bankAccount: bankAccount,
        dailyLivingAmount: money,
        mobilityAmount: money,
        totalPayment: money,
      },
    },
  },
};

function pipComponent(): Document {
  return {
    bsonType: "object",
    required: ["awarded", "rate", "points"],
    properties: {
      awarded: { bsonType: "bool" },
      rate: { enum: ["Standard", "Enhanced", "Nil"] },
      points: { bsonType: ["int", "long"], minimum: 0 },
      descriptors: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["activity", "descriptorScore", "descriptorText"],
          properties: {
            activity: { bsonType: "string" },
            descriptorScore: { bsonType: ["int", "long"], minimum: 0 },
            descriptorText: { bsonType: "string" },
          },
        },
      },
    },
  };
}

/** State Pension: the benefit type added *after* the collection went live. */
const statePension = {
  title: "State Pension v1",
  bsonType: "object",
  required: ["entitlement"],
  properties: {
    benefitType: { enum: ["State Pension"] },
    entitlement: {
      bsonType: "object",
      required: ["qualifyingYears", "fullRateEligible", "weeklyRate"],
      properties: {
        qualifyingYears: { bsonType: ["int", "long"], minimum: 0, maximum: 50 },
        fullRateEligible: { bsonType: "bool" },
        weeklyRate: money,
        protectedPayment: money,
        deferralUplift: money,
      },
    },
    paymentDetails: {
      bsonType: "object",
      required: ["paymentDate", "paymentMethod", "totalPayment"],
      properties: {
        paymentDate: { bsonType: "string" },
        paymentFrequency: { enum: ["Weekly", "4-weekly"] },
        paymentMethod: { enum: ["BACS", "Faster Payments", "Cheque"] },
        bankAccount: bankAccount,
        totalPayment: money,
      },
    },
  },
};

/* ------------------------------------------------------------------ *
 * Composing the contract.
 *
 * Migrations *add* a branch to whatever the collection already accepts,
 * rather than replacing the validator with a fixed snapshot. That is what
 * makes them order-independent — and it is how you would do it for real,
 * where migrations land in whatever order the release train allows.
 * ------------------------------------------------------------------ */

export const BRANCHES: Record<string, Document> = {
  "Universal Credit v1": universalCreditV1,
  "Universal Credit v2": universalCreditV2,
  "Personal Independence Payment v1": pip,
  "State Pension v1": statePension,
};

export function buildValidator(titles: string[]): Document {
  const ordered = Object.keys(BRANCHES).filter((t) => titles.includes(t));
  return {
    $jsonSchema: {
      ...core,
      title: `UK Benefit Payment — accepts: ${ordered.join(", ")}`,
      oneOf: ordered.map((t) => BRANCHES[t]!),
    },
  };
}

/** What the collection starts life accepting, before any migration runs. */
export const validatorV1 = buildValidator([
  "Universal Credit v1",
  "Personal Independence Payment v1",
]);

/** Reads the branches currently enforced by the collection. */
export async function currentBranches(
  db: Db,
  collection: string,
): Promise<string[]> {
  const [info] = await db
    .listCollections({ name: collection }, { nameOnly: false })
    .toArray();
  const oneOf = info?.options?.validator?.$jsonSchema?.oneOf as
    | { title?: string }[]
    | undefined;
  return (oneOf ?? []).flatMap((b) => (b.title ? [b.title] : []));
}

/**
 * Adds a branch to the live contract, online, preserving whatever is already
 * there. Returns false if that branch was already accepted.
 */
export async function enableBranch(
  db: Db,
  collection: string,
  title: string,
): Promise<{ added: boolean; titles: string[] }> {
  const existing = await currentBranches(db, collection);
  if (existing.includes(title)) return { added: false, titles: existing };

  const titles = [...existing, title];
  await db.command({
    collMod: collection,
    validator: buildValidator(titles),
    validationLevel: "strict",
    validationAction: "error",
  });
  return { added: true, titles };
}

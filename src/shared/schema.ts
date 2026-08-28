/**
 * The contract lives here, in code.
 *
 * Relational habit:  ALTER TABLE, migration scripts, downtime, one table per benefit
 *                    (or a 200-column "one big table" with 180 NULLs).
 * Document approach: one collection, one discriminated union, new benefit types are
 *                    additive — existing documents and existing code are untouched.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Shared building blocks — the "core" every UK benefit payment shares
 * ------------------------------------------------------------------ */

const Money = z.number().nonnegative().finite();

export const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  postcode: z
    .string()
    .regex(/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, "Invalid UK postcode"),
});

export const BankAccountSchema = z.object({
  sortCode: z
    .string()
    .regex(/^\d{2}-\d{2}-\d{2}$/, "Sort code must be NN-NN-NN"),
  accountNumberLast4: z.string().regex(/^\d{4}$/),
});

export const AuditEventSchema = z.object({
  event: z.string().min(1),
  timestamp: z.string().datetime(),
  actor: z.string().min(1),
});

export const AssessmentPeriodSchema = z.object({
  startDate: z.string().date(),
  endDate: z.string().date(),
});

/** Fields present on EVERY payment document, regardless of benefit type. */
const PaymentCore = {
  _id: z
    .string()
    .regex(/^BEN-\d{4}-\d{7}$/, "Payment id must be BEN-YYYY-NNNNNNN"),
  claimantId: z
    .string()
    .regex(/^NIN-[A-Z]{2}\d{6}[A-D]$/, "Invalid National Insurance reference"),
  claimReference: z.string().min(1),
  status: z.enum(["Paid", "Pending", "Held", "Cancelled", "Failed"]),
  personalDetails: z
    .object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      dateOfBirth: z.string().date(),
      address: AddressSchema,
    })
    .passthrough(), // benefit-specific extras (e.g. householdType) are welcome
  auditTrail: z.array(AuditEventSchema).min(1),
};

/* ------------------------------------------------------------------ *
 * Variant 1 — Universal Credit, v1
 * ------------------------------------------------------------------ */

export const UniversalCreditV1Schema = z.object({
  ...PaymentCore,
  benefitType: z.literal("Universal Credit"),
  // Absent means v1: documents written before versioning existed stay valid
  // and need no backfill.
  schemaVersion: z.literal(1).default(1),
  personalDetails: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    dateOfBirth: z.string().date(),
    address: AddressSchema,
    householdType: z.enum([
      "single",
      "single with children",
      "couple",
      "couple with children",
    ]),
    dependents: z
      .array(
        z.object({
          name: z.string().min(1),
          dateOfBirth: z.string().date(),
          relationship: z.string().min(1),
        }),
      )
      .default([]),
  }),
  assessmentPeriod: AssessmentPeriodSchema,
  paymentDetails: z.object({
    paymentDate: z.string().date(),
    paymentMethod: z.enum(["BACS", "Faster Payments", "Cheque"]),
    bankAccount: BankAccountSchema.optional(),
    grossEntitlement: Money,
    deductions: z
      .array(z.object({ type: z.string().min(1), amount: Money }))
      .default([]),
    netPayment: Money,
  }),
  elements: z
    .array(
      z.object({
        elementType: z.string().min(1),
        amount: Money,
        childrenCovered: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
  sanctions: z
    .array(z.object({ reason: z.string(), level: z.string(), amount: Money }))
    .default([]),
  flags: z.object({
    fraudCheckPassed: z.boolean(),
    manualReviewRequired: z.boolean(),
  }),
});

/* ------------------------------------------------------------------ *
 * Variant 1 — Universal Credit, v2.
 *
 * The 2026 earnings-taper change: deductions must now cite a recovery
 * reference, and the earned income used in the calculation is recorded.
 * Only this benefit type is versioned up. PIP and State Pension documents,
 * and every existing v1 UC document, are untouched.
 * ------------------------------------------------------------------ */

export const UniversalCreditV2Schema = UniversalCreditV1Schema.extend({
  schemaVersion: z.literal(2),
  paymentDetails: z.object({
    paymentDate: z.string().date(),
    paymentMethod: z.enum(["BACS", "Faster Payments", "Cheque"]),
    bankAccount: BankAccountSchema.optional(),
    grossEntitlement: Money,
    deductions: z
      .array(
        z.object({
          type: z.string().min(1),
          amount: Money,
          recoveryReference: z
            .string()
            .regex(/^REC-\d{8}$/, "Recovery reference must be REC-NNNNNNNN"),
        }),
      )
      .default([]),
    netPayment: Money,
  }),
  earnedIncome: z.object({
    monthlyEarnings: Money,
    workAllowanceApplied: Money,
    taperDeduction: Money,
  }),
});

/* ------------------------------------------------------------------ *
 * Variant 2 — Personal Independence Payment
 * ------------------------------------------------------------------ */

const PipComponentSchema = z.object({
  awarded: z.boolean(),
  rate: z.enum(["Standard", "Enhanced", "Nil"]),
  points: z.number().int().nonnegative(),
  descriptors: z
    .array(
      z.object({
        activity: z.string().min(1),
        descriptorScore: z.number().int().nonnegative(),
        descriptorText: z.string().min(1),
      }),
    )
    .default([]),
});

export const PipSchema = z.object({
  ...PaymentCore,
  benefitType: z.literal("Personal Independence Payment"),
  schemaVersion: z.literal(1).default(1),
  assessmentPeriod: AssessmentPeriodSchema.extend({
    reviewType: z.enum([
      "Award Review",
      "Planned Review",
      "Change of Circumstances",
    ]),
    nextReviewDate: z.string().date().optional(),
  }),
  assessment: z.object({
    assessmentDate: z.string().date(),
    assessmentProvider: z.string().min(1),
    dailyLivingComponent: PipComponentSchema,
    mobilityComponent: PipComponentSchema,
  }),
  paymentDetails: z.object({
    paymentDate: z.string().date(),
    paymentFrequency: z.enum(["Weekly", "4-weekly", "Monthly"]),
    paymentMethod: z.enum(["BACS", "Faster Payments", "Cheque"]),
    bankAccount: BankAccountSchema.optional(),
    dailyLivingAmount: Money,
    mobilityAmount: Money,
    totalPayment: Money,
  }),
  appeals: z
    .array(
      z.object({
        raisedOn: z.string().date(),
        stage: z.string(),
        outcome: z.string().optional(),
      }),
    )
    .default([]),
  flags: z.object({
    terminalIllnessClaim: z.boolean(),
    fraudCheckPassed: z.boolean(),
    manualReviewRequired: z.boolean(),
  }),
});

/* ------------------------------------------------------------------ *
 * Variant 3 — State Pension.
 *
 * THIS is the punchline of the demo: adding a brand new benefit type is
 * ~25 lines of TypeScript. No migration. No downtime. No NULL columns
 * bolted onto the other two benefit types.
 * ------------------------------------------------------------------ */

export const StatePensionSchema = z.object({
  ...PaymentCore,
  benefitType: z.literal("State Pension"),
  schemaVersion: z.literal(1).default(1),
  assessmentPeriod: AssessmentPeriodSchema,
  entitlement: z.object({
    qualifyingYears: z.number().int().min(0).max(50),
    fullRateEligible: z.boolean(),
    weeklyRate: Money,
    protectedPayment: Money.optional(),
    deferralUplift: Money.optional(),
  }),
  paymentDetails: z.object({
    paymentDate: z.string().date(),
    paymentFrequency: z.enum(["Weekly", "4-weekly"]),
    paymentMethod: z.enum(["BACS", "Faster Payments", "Cheque"]),
    bankAccount: BankAccountSchema.optional(),
    totalPayment: Money,
  }),
  flags: z.object({
    fraudCheckPassed: z.boolean(),
    manualReviewRequired: z.boolean(),
  }),
});

/* ------------------------------------------------------------------ *
 * The polymorphic union — one collection, many shapes, one type.
 * Dispatch is on two axes: benefit type, then schema version.
 * ------------------------------------------------------------------ */

export type UniversalCreditV1Payment = z.infer<typeof UniversalCreditV1Schema>;
export type UniversalCreditV2Payment = z.infer<typeof UniversalCreditV2Schema>;
export type UniversalCreditPayment =
  | UniversalCreditV1Payment
  | UniversalCreditV2Payment;
export type PipPayment = z.infer<typeof PipSchema>;
export type StatePensionPayment = z.infer<typeof StatePensionSchema>;
export type BenefitPayment =
  | UniversalCreditPayment
  | PipPayment
  | StatePensionPayment;
export type BenefitType = BenefitPayment["benefitType"];

export const BENEFIT_TYPES: BenefitType[] = [
  "Universal Credit",
  "Personal Independence Payment",
  "State Pension",
];

/** Every shape this codebase can read. Old versions are never removed from here. */
const VERSIONED_SCHEMAS: Record<string, Record<number, z.ZodTypeAny>> = {
  "Universal Credit": {
    1: UniversalCreditV1Schema,
    2: UniversalCreditV2Schema,
  },
  "Personal Independence Payment": { 1: PipSchema },
  "State Pension": { 1: StatePensionSchema },
};

/**
 * The version each benefit type is currently *written* at. Bump one entry when
 * that type's shape changes; the others are unaffected, and historical documents
 * keep their original version rather than being rewritten.
 */
export const CURRENT_SCHEMA_VERSION = {
  "Universal Credit": 2,
  "Personal Independence Payment": 1,
  "State Pension": 1,
} as const satisfies Record<BenefitType, number>;

function issue(path: (string | number)[], message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path, message }]);
}

/**
 * Resolves (benefitType, schemaVersion) to a concrete schema, so validation
 * errors point at the real field rather than at "no union member matched".
 */
export const BenefitPaymentSchema = {
  safeParse(raw: unknown): z.SafeParseReturnType<unknown, BenefitPayment> {
    const doc = raw as { benefitType?: unknown; schemaVersion?: unknown };
    const byVersion = VERSIONED_SCHEMAS[String(doc?.benefitType)];
    if (!byVersion) {
      return {
        success: false,
        error: issue(
          ["benefitType"],
          `Unknown benefit type: ${String(doc?.benefitType)}`,
        ),
      };
    }
    const version =
      doc?.schemaVersion === undefined ? 1 : Number(doc.schemaVersion);
    const schema = byVersion[version];
    if (!schema) {
      return {
        success: false,
        error: issue(
          ["schemaVersion"],
          `Unsupported schema version ${version} for ${String(doc?.benefitType)}`,
        ),
      };
    }
    return schema.safeParse(raw) as z.SafeParseReturnType<
      unknown,
      BenefitPayment
    >;
  },

  parse(raw: unknown): BenefitPayment {
    const result = this.safeParse(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
};

/** Provenance stamped on every document at ingest time — the dashboard reports on it. */
export interface IngestMetadata {
  sourceFile: string;
  fileRecordNumber: number;
  ingestedAt: Date;
}

export type StoredPayment = BenefitPayment & { ingest: IngestMetadata };

/**
 * Every variant stores its headline amount under a different key
 * (netPayment / totalPayment). Type narrowing keeps that honest in code,
 * and `$ifNull` keeps it honest in aggregation — see `stats.ts`.
 */
export function headlineAmount(payment: BenefitPayment): number {
  switch (payment.benefitType) {
    case "Universal Credit":
      return payment.paymentDetails.netPayment;
    case "Personal Independence Payment":
    case "State Pension":
      return payment.paymentDetails.totalPayment;
  }
}

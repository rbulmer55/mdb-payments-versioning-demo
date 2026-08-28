/**
 * Every figure on the dashboard comes from the aggregation framework,
 * reading one polymorphic collection. No joins, no UNION ALL across
 * three benefit tables, no per-type endpoint.
 */
import type { Document } from "mongodb";
import { getPayments } from "../shared/db.js";

/** The one expression that reconciles every benefit type's headline amount. */
const AMOUNT = {
  $ifNull: ["$paymentDetails.netPayment", "$paymentDetails.totalPayment"],
};

export async function getStats(): Promise<Document> {
  const coll = await getPayments();

  const [facets] = await coll
    .aggregate([
      {
        $facet: {
          headline: [
            {
              $group: {
                _id: null,
                payments: { $sum: 1 },
                households: { $addToSet: "$claimantId" },
                totalPaid: { $sum: AMOUNT },
                avgPayment: { $avg: AMOUNT },
                maxPayment: { $max: AMOUNT },
              },
            },
            {
              $project: {
                _id: 0,
                payments: 1,
                households: { $size: "$households" },
                totalPaid: { $round: ["$totalPaid", 2] },
                avgPayment: { $round: ["$avgPayment", 2] },
                maxPayment: { $round: ["$maxPayment", 2] },
              },
            },
          ],

          byType: [
            {
              $group: {
                _id: "$benefitType",
                count: { $sum: 1 },
                totalPaid: { $sum: AMOUNT },
                avgPayment: { $avg: AMOUNT },
              },
            },
            {
              $project: {
                _id: 0,
                benefitType: "$_id",
                count: 1,
                totalPaid: { $round: ["$totalPaid", 2] },
                avgPayment: { $round: ["$avgPayment", 2] },
              },
            },
            { $sort: { count: -1 } },
          ],

          // Mixed versions coexisting is the normal, healthy state — not a backlog.
          byVersion: [
            {
              $group: {
                _id: {
                  benefitType: "$benefitType",
                  schemaVersion: { $ifNull: ["$schemaVersion", 1] },
                },
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                benefitType: "$_id.benefitType",
                schemaVersion: "$_id.schemaVersion",
                count: 1,
              },
            },
            { $sort: { benefitType: 1, schemaVersion: 1 } },
          ],

          // Provenance: every figure above traces back to one of these files.
          byFile: [
            {
              $group: {
                _id: "$ingest.sourceFile",
                count: { $sum: 1 },
                totalPaid: { $sum: AMOUNT },
                benefitTypes: { $addToSet: "$benefitType" },
                firstPaymentDate: { $min: "$paymentDetails.paymentDate" },
                lastPaymentDate: { $max: "$paymentDetails.paymentDate" },
                ingestedAt: { $max: "$ingest.ingestedAt" },
              },
            },
            {
              $project: {
                _id: 0,
                sourceFile: "$_id",
                count: 1,
                totalPaid: { $round: ["$totalPaid", 2] },
                benefitTypes: 1,
                firstPaymentDate: 1,
                lastPaymentDate: 1,
                ingestedAt: 1,
              },
            },
            { $sort: { sourceFile: 1 } },
          ],

          byStatus: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                value: { $sum: AMOUNT },
              },
            },
            {
              $project: {
                _id: 0,
                status: "$_id",
                count: 1,
                value: { $round: ["$value", 2] },
              },
            },
            { $sort: { count: -1 } },
          ],

          byCity: [
            {
              $group: {
                _id: "$personalDetails.address.city",
                count: { $sum: 1 },
                totalPaid: { $sum: AMOUNT },
              },
            },
            {
              $project: {
                _id: 0,
                city: "$_id",
                count: 1,
                totalPaid: { $round: ["$totalPaid", 2] },
              },
            },
            { $sort: { totalPaid: -1 } },
            { $limit: 10 },
          ],

          trend: [
            {
              $group: {
                _id: {
                  month: {
                    $substrBytes: ["$paymentDetails.paymentDate", 0, 7],
                  },
                  benefitType: "$benefitType",
                },
                totalPaid: { $sum: AMOUNT },
              },
            },
            {
              $project: {
                _id: 0,
                month: "$_id.month",
                benefitType: "$_id.benefitType",
                totalPaid: { $round: ["$totalPaid", 2] },
              },
            },
            { $sort: { month: 1 } },
          ],

          // UC-only shape: deductions live in an array of sub-documents.
          deductions: [
            { $match: { "paymentDetails.deductions.0": { $exists: true } } },
            { $unwind: "$paymentDetails.deductions" },
            {
              $group: {
                _id: "$paymentDetails.deductions.type",
                count: { $sum: 1 },
                total: { $sum: "$paymentDetails.deductions.amount" },
              },
            },
            {
              $project: {
                _id: 0,
                type: "$_id",
                count: 1,
                total: { $round: ["$total", 2] },
              },
            },
            { $sort: { total: -1 } },
          ],

          // UC-only shape: award elements.
          ucElements: [
            { $match: { benefitType: "Universal Credit" } },
            { $unwind: "$elements" },
            {
              $group: {
                _id: "$elements.elementType",
                total: { $sum: "$elements.amount" },
                avg: { $avg: "$elements.amount" },
              },
            },
            {
              $project: {
                _id: 0,
                elementType: "$_id",
                total: { $round: ["$total", 2] },
                avg: { $round: ["$avg", 2] },
              },
            },
            { $sort: { total: -1 } },
          ],

          // PIP-only shape: component award rates.
          pipRates: [
            { $match: { benefitType: "Personal Independence Payment" } },
            {
              $group: {
                _id: {
                  dailyLiving: "$assessment.dailyLivingComponent.rate",
                  mobility: "$assessment.mobilityComponent.rate",
                },
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                dailyLiving: "$_id.dailyLiving",
                mobility: "$_id.mobility",
                count: 1,
              },
            },
            { $sort: { count: -1 } },
          ],

          // State Pension-only shape (empty until `npm run extend` is run).
          pensionEntitlement: [
            { $match: { benefitType: "State Pension" } },
            {
              $group: {
                _id: "$entitlement.fullRateEligible",
                count: { $sum: 1 },
                avgQualifyingYears: { $avg: "$entitlement.qualifyingYears" },
                avgWeeklyRate: { $avg: "$entitlement.weeklyRate" },
              },
            },
            {
              $project: {
                _id: 0,
                fullRateEligible: "$_id",
                count: 1,
                avgQualifyingYears: { $round: ["$avgQualifyingYears", 1] },
                avgWeeklyRate: { $round: ["$avgWeeklyRate", 2] },
              },
            },
          ],

          riskFlags: [
            {
              $group: {
                _id: null,
                manualReview: {
                  $sum: { $cond: ["$flags.manualReviewRequired", 1, 0] },
                },
                fraudCheckFailed: {
                  $sum: { $cond: ["$flags.fraudCheckPassed", 0, 1] },
                },
                sanctioned: {
                  $sum: {
                    $cond: [
                      { $gt: [{ $size: { $ifNull: ["$sanctions", []] } }, 0] },
                      1,
                      0,
                    ],
                  },
                },
                withDependents: {
                  $sum: {
                    $cond: [
                      {
                        $gt: [
                          {
                            $size: {
                              $ifNull: ["$personalDetails.dependents", []],
                            },
                          },
                          0,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            { $project: { _id: 0 } },
          ],
        },
      },
    ])
    .toArray();

  return {
    headline: facets?.headline?.[0] ?? {
      payments: 0,
      households: 0,
      totalPaid: 0,
      avgPayment: 0,
      maxPayment: 0,
    },
    byType: facets?.byType ?? [],
    byVersion: facets?.byVersion ?? [],
    byFile: facets?.byFile ?? [],
    byStatus: facets?.byStatus ?? [],
    byCity: facets?.byCity ?? [],
    trend: facets?.trend ?? [],
    deductions: facets?.deductions ?? [],
    ucElements: facets?.ucElements ?? [],
    pipRates: facets?.pipRates ?? [],
    pensionEntitlement: facets?.pensionEntitlement ?? [],
    riskFlags: facets?.riskFlags?.[0] ?? {},
  };
}

export async function getSamplePayments(
  benefitType: string | undefined,
  limit: number,
  schemaVersion?: number,
) {
  const coll = await getPayments();
  const filter: Record<string, unknown> = {};
  if (benefitType) filter.benefitType = benefitType;
  // Absent means v1, so match both representations.
  if (schemaVersion === 1) filter.schemaVersion = { $in: [1, null] };
  else if (schemaVersion !== undefined) filter.schemaVersion = schemaVersion;
  return coll
    .find(filter as never)
    .sort({ "paymentDetails.paymentDate": -1 })
    .limit(limit)
    .toArray();
}

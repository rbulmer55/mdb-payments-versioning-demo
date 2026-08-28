/**
 * Produces the inbound payment files. This stands in for the upstream DWP
 * batch process — run it once and from then on the demo only ever reads
 * files from disk. Deterministic, so the dashboard numbers are stable.
 */
import type {
  BenefitPayment,
  PipPayment,
  StatePensionPayment,
  UniversalCreditV1Payment,
} from "../shared/schema.js";
import { CURRENT_SCHEMA_VERSION } from "../shared/schema.js";

const CITIES = [
  ["Manchester", "M14 5RT"],
  ["Leeds", "LS6 3PJ"],
  ["Birmingham", "B15 2TT"],
  ["Glasgow", "G12 8QQ"],
  ["Cardiff", "CF14 3NW"],
  ["Bristol", "BS5 9AA"],
  ["Sheffield", "S1 4QW"],
  ["Newcastle upon Tyne", "NE1 3RQ"],
  ["Liverpool", "L1 8JQ"],
  ["London", "E14 5AB"],
  ["Nottingham", "NG7 2QR"],
  ["Belfast", "BT1 5GS"],
] as const;

const FIRST = [
  "Aisha",
  "Ben",
  "Carys",
  "Dele",
  "Eve",
  "Farhan",
  "Grace",
  "Hamza",
  "Isla",
  "Jack",
  "Kira",
  "Leo",
  "Maya",
  "Noah",
  "Olu",
  "Pia",
  "Rhys",
  "Sofia",
  "Tom",
  "Zara",
];
const LAST = [
  "Ahmed",
  "Brooks",
  "Clarke",
  "Davies",
  "Evans",
  "Foster",
  "Gill",
  "Hughes",
  "Iqbal",
  "Jones",
  "Kaur",
  "Lewis",
  "Murray",
  "Nolan",
  "O'Neill",
  "Patel",
  "Quinn",
  "Roberts",
  "Singh",
  "Taylor",
];
const STATUSES = [
  "Paid",
  "Paid",
  "Paid",
  "Paid",
  "Paid",
  "Paid",
  "Paid",
  "Pending",
  "Held",
  "Failed",
  "Cancelled",
] as const;
const DEDUCTIONS = [
  "Advance Repayment",
  "Council Tax Arrears",
  "Rent Arrears",
  "Overpayment Recovery",
  "Child Maintenance",
];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BatchOptions {
  /** Calendar month (1-12) the batch file covers. */
  month: number;
  count: number;
  /** Share of the batch that is Universal Credit; the remainder is PIP. */
  ucShare?: number;
  /** Which Universal Credit schema version to write. PIP is unaffected. */
  ucVersion?: 1 | 2;
}

export function generateBatch({
  month,
  count,
  ucShare = 0.62,
  ucVersion = 1,
}: BatchOptions): BenefitPayment[] {
  const rnd = mulberry32(20260000 + month * 977 + count);
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rnd() * arr.length)]!;
  const money = (min: number, max: number) =>
    Math.round((min + rnd() * (max - min)) * 100) / 100;
  const mm = String(month).padStart(2, "0");
  const prevMm = String(month - 1).padStart(2, "0");
  const nin = () =>
    `NIN-${pick(["AB", "CD", "EF", "GH", "JK", "LM", "PR", "ST", "WX", "ZY"])}${String(
      Math.floor(rnd() * 1_000_000),
    ).padStart(6, "0")}${pick(["A", "B", "C", "D"])}`;
  const payDate = () =>
    `2026-${mm}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;

  const out: BenefitPayment[] = [];
  for (let i = 1; i <= count; i++) {
    // Month digit + 6 sequence digits keeps ids unique across batch files.
    const id = `BEN-2026-${month}${String(i).padStart(6, "0")}`;
    const [city, postcode] = pick(CITIES);
    const person = {
      firstName: pick(FIRST),
      lastName: pick(LAST),
      dateOfBirth: `19${60 + Math.floor(rnd() * 40)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
      address: {
        line1: `${1 + Math.floor(rnd() * 200)} ${pick(["Elm", "Oak", "Mill", "Church", "Station"])} ${pick(["Road", "Street", "Grove", "Close"])}`,
        city,
        postcode,
      },
    };
    const audit = [
      {
        event: "Claim assessed",
        timestamp: `2026-${mm}-02T09:00:00Z`,
        actor: "system",
      },
      {
        event: "Payment approved",
        timestamp: `2026-${mm}-05T14:00:00Z`,
        actor: `caseworker:CW${1000 + Math.floor(rnd() * 8999)}`,
      },
    ];

    if (rnd() < ucShare) {
      const children = rnd() < 0.45 ? 1 + Math.floor(rnd() * 3) : 0;
      const standard = money(311, 628);
      const child = children
        ? Math.round(money(150, 300) * children * 100) / 100
        : 0;
      const housing = rnd() < 0.7 ? money(200, 700) : 0;
      const gross = Math.round((standard + child + housing) * 100) / 100;
      const deductions =
        rnd() < 0.5 ? [{ type: pick(DEDUCTIONS), amount: money(20, 120) }] : [];
      const deducted = deductions.reduce((s, d) => s + d.amount, 0);
      const monthlyEarnings = rnd() < 0.35 ? money(200, 1400) : 0;
      const workAllowanceApplied = monthlyEarnings
        ? Math.min(monthlyEarnings, 404)
        : 0;
      const uc: UniversalCreditV1Payment = {
        _id: id,
        claimantId: nin(),
        benefitType: "Universal Credit",
        schemaVersion: 1,
        claimReference: `UC-${Math.floor(1_000_000_000 + rnd() * 8_999_999_999)}`,
        personalDetails: {
          ...person,
          householdType: children
            ? pick(["single with children", "couple with children"])
            : pick(["single", "couple"]),
          dependents: Array.from({ length: children }, (_, c) => ({
            name: `${pick(FIRST)} ${person.lastName}`,
            dateOfBirth: `201${c + 4}-0${1 + Math.floor(rnd() * 9)}-0${1 + Math.floor(rnd() * 8)}`,
            relationship: pick(["son", "daughter"]),
          })),
        },
        assessmentPeriod: {
          startDate: `2026-${prevMm}-01`,
          endDate: `2026-${prevMm}-28`,
        },
        paymentDetails: {
          paymentDate: payDate(),
          paymentMethod: rnd() < 0.9 ? "BACS" : "Faster Payments",
          bankAccount: {
            sortCode: pick([
              "20-45-89",
              "09-01-28",
              "83-26-14",
              "40-11-22",
              "60-16-04",
            ]),
            accountNumberLast4: String(Math.floor(rnd() * 10000)).padStart(
              4,
              "0",
            ),
          },
          grossEntitlement: gross,
          deductions,
          netPayment: Math.round((gross - deducted) * 100) / 100,
        },
        elements: [
          { elementType: "Standard Allowance", amount: standard },
          ...(child
            ? [
                {
                  elementType: "Child Element",
                  amount: child,
                  childrenCovered: children,
                },
              ]
            : []),
          ...(housing
            ? [{ elementType: "Housing Element", amount: housing }]
            : []),
        ],
        sanctions: [],
        status: pick(STATUSES),
        flags: {
          fraudCheckPassed: rnd() > 0.03,
          manualReviewRequired: rnd() < 0.12,
        },
        auditTrail: audit,
      };
      out.push(
        ucVersion === 2
          ? {
              ...uc,
              schemaVersion: 2,
              paymentDetails: {
                ...uc.paymentDetails,
                deductions: uc.paymentDetails.deductions.map((d) => ({
                  ...d,
                  recoveryReference: `REC-${10_000_000 + Math.floor(rnd() * 89_999_999)}`,
                })),
              },
              earnedIncome: {
                monthlyEarnings,
                workAllowanceApplied,
                taperDeduction:
                  Math.round(
                    Math.max(0, monthlyEarnings - workAllowanceApplied) *
                      0.55 *
                      100,
                  ) / 100,
              },
            }
          : uc,
      );
    } else {
      const dlAwarded = rnd() < 0.8;
      const mobAwarded = rnd() < 0.6;
      const dlAmount = dlAwarded ? (rnd() < 0.5 ? 434.6 : 290.6) : 0;
      const mobAmount = mobAwarded ? (rnd() < 0.5 ? 304.8 : 194.8) : 0;
      const pip: PipPayment = {
        _id: id,
        claimantId: nin(),
        benefitType: "Personal Independence Payment",
        schemaVersion: CURRENT_SCHEMA_VERSION["Personal Independence Payment"],
        claimReference: `PIP-${Math.floor(1_000_000_000 + rnd() * 8_999_999_999)}`,
        personalDetails: person,
        assessmentPeriod: {
          startDate: `2026-${prevMm}-01`,
          endDate: `2026-${prevMm}-28`,
          reviewType: pick([
            "Award Review",
            "Planned Review",
            "Change of Circumstances",
          ]),
          nextReviewDate: "2028-07-01",
        },
        assessment: {
          assessmentDate: `2026-${prevMm}-18`,
          assessmentProvider: pick([
            "Independent Assessment Services",
            "Capita Health",
          ]),
          dailyLivingComponent: {
            awarded: dlAwarded,
            rate: dlAwarded
              ? dlAmount > 400
                ? "Enhanced"
                : "Standard"
              : "Nil",
            points: dlAwarded
              ? 8 + Math.floor(rnd() * 8)
              : Math.floor(rnd() * 7),
            descriptors: [
              {
                activity: pick([
                  "Preparing food",
                  "Washing and bathing",
                  "Managing medication",
                  "Dressing and undressing",
                ]),
                descriptorScore: 2 + Math.floor(rnd() * 6),
                descriptorText: "Needs assistance to complete the activity",
              },
            ],
          },
          mobilityComponent: {
            awarded: mobAwarded,
            rate: mobAwarded
              ? mobAmount > 250
                ? "Enhanced"
                : "Standard"
              : "Nil",
            points: mobAwarded
              ? 8 + Math.floor(rnd() * 8)
              : Math.floor(rnd() * 7),
            descriptors: [
              {
                activity: pick([
                  "Moving around",
                  "Planning and following journeys",
                ]),
                descriptorScore: 4 + Math.floor(rnd() * 9),
                descriptorText: "Mobility limited without an aid or appliance",
              },
            ],
          },
        },
        paymentDetails: {
          paymentDate: payDate(),
          paymentFrequency: "4-weekly",
          paymentMethod: "BACS",
          bankAccount: {
            sortCode: pick(["30-99-50", "55-70-01", "77-04-19", "40-11-22"]),
            accountNumberLast4: String(Math.floor(rnd() * 10000)).padStart(
              4,
              "0",
            ),
          },
          dailyLivingAmount: dlAmount,
          mobilityAmount: mobAmount,
          totalPayment: Math.round((dlAmount + mobAmount) * 100) / 100,
        },
        appeals: [],
        status: pick(STATUSES),
        flags: {
          terminalIllnessClaim: rnd() < 0.02,
          fraudCheckPassed: rnd() > 0.03,
          manualReviewRequired: rnd() < 0.12,
        },
        auditTrail: audit,
      };
      out.push(pip);
    }
  }
  return out;
}

/** The benefit type added after go-live — same generator, separate batch file. */
export function generateStatePensionBatch({
  month,
  count,
}: Omit<BatchOptions, "ucShare">): StatePensionPayment[] {
  const rnd = mulberry32(20269000 + month * 31 + count);
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rnd() * arr.length)]!;
  const mm = String(month).padStart(2, "0");

  return Array.from({ length: count }, (_, idx) => {
    const i = idx + 1;
    const [city, postcode] = pick(CITIES);
    const qualifyingYears = 20 + Math.floor(rnd() * 26);
    const fullRateEligible = qualifyingYears >= 35;
    const weeklyRate = fullRateEligible
      ? 221.2
      : Math.round((221.2 / 35) * qualifyingYears * 100) / 100;
    const deferralUplift =
      rnd() < 0.2 ? Math.round(rnd() * 20 * 100) / 100 : undefined;
    const protectedPayment =
      !fullRateEligible && rnd() < 0.3
        ? Math.round(rnd() * 15 * 100) / 100
        : undefined;

    return {
      // Prefix 5 is reserved for State Pension; monthly batches use their month digit.
      _id: `BEN-2026-5${String(i).padStart(6, "0")}`,
      claimantId: `NIN-${pick(["AB", "CD", "EF", "GH", "JK", "LM", "PR", "ST", "WX", "ZY"])}${String(Math.floor(rnd() * 1_000_000)).padStart(6, "0")}${pick(["A", "B", "C", "D"])}`,
      benefitType: "State Pension",
      schemaVersion: CURRENT_SCHEMA_VERSION["State Pension"],
      claimReference: `SP-${Math.floor(1_000_000_000 + rnd() * 8_999_999_999)}`,
      personalDetails: {
        firstName: pick(FIRST),
        lastName: pick(LAST),
        dateOfBirth: `19${52 + Math.floor(rnd() * 8)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
        address: {
          line1: `${1 + Math.floor(rnd() * 200)} ${pick(["Coronation", "Jubilee", "Manor", "Orchard", "Priory"])} ${pick(["Avenue", "Road", "Close", "Gardens"])}`,
          city,
          postcode,
        },
      },
      assessmentPeriod: {
        startDate: `2026-${mm}-01`,
        endDate: `2026-${mm}-28`,
      },
      entitlement: {
        qualifyingYears,
        fullRateEligible,
        weeklyRate,
        ...(protectedPayment !== undefined ? { protectedPayment } : {}),
        ...(deferralUplift !== undefined ? { deferralUplift } : {}),
      },
      paymentDetails: {
        paymentDate: `2026-${mm}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`,
        paymentFrequency: "4-weekly",
        paymentMethod: "BACS",
        bankAccount: {
          sortCode: pick(["60-16-04", "77-04-19", "83-26-14", "20-45-89"]),
          accountNumberLast4: String(Math.floor(rnd() * 10000)).padStart(
            4,
            "0",
          ),
        },
        totalPayment:
          Math.round(
            (weeklyRate + (deferralUplift ?? 0) + (protectedPayment ?? 0)) *
              4 *
              100,
          ) / 100,
      },
      status: pick(STATUSES),
      flags: {
        fraudCheckPassed: rnd() > 0.02,
        manualReviewRequired: rnd() < 0.08,
      },
      auditTrail: [
        {
          event: "Entitlement calculated",
          timestamp: `2026-${mm}-01T06:00:00Z`,
          actor: "system",
        },
        {
          event: "Payment issued",
          timestamp: `2026-${mm}-17T08:00:00Z`,
          actor: "system",
        },
      ],
    };
  });
}

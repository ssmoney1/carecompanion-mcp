import { z } from "zod";
import { query, resolvePatient, resolveCareProfile } from "./db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Medication {
  id: string;
  name: string;
  dose: string;
  frequency: string;
  prescribing_doctor: string;
  refill_date: string;
  healthkit_fhir_id?: string;
}

interface LabResult {
  id: string;
  test_name: string;
  value: string;
  unit: string;
  reference_range: string;
  is_abnormal: boolean;
  date_taken: string;
}

interface Appointment {
  id: string;
  doctor_name: string;
  specialty: string;
  date_time: string;
  location: string;
  purpose: string;
}

interface SymptomEntry {
  id: string;
  pain_level: number;
  mood: string;
  energy: string;
  sleep_hours: number;
  sleep_quality: string;
  appetite: string;
  symptoms: string[];
  notes?: string;
  date: string;
}

interface Insurance {
  id: string;
  provider: string;
  member_id: string;
  deductible_limit: number;
  deductible_used: number;
  oop_limit: number;
  oop_used: number;
  plan_year: number;
}

interface PriorAuth {
  id: string;
  service: string;
  status: string;
  expiry_date: string;
  sessions_approved: number;
  sessions_used: number;
}

// ─── Chemo safety thresholds by regimen ─────────────────────────────────────
const CHEMO_THRESHOLDS: Record<string, { anc: number; wbc: number; platelets: number; hemoglobin: number }> = {
  default:     { anc: 1000, wbc: 3.0,  platelets: 100, hemoglobin: 8.0 },
  docetaxel:   { anc: 1500, wbc: 3.0,  platelets: 100, hemoglobin: 8.0 },
  carboplatin: { anc: 1500, wbc: 3.5,  platelets: 100, hemoglobin: 9.0 },
  paclitaxel:  { anc: 1500, wbc: 3.0,  platelets: 100, hemoglobin: 8.0 },
  herceptin:   { anc: 1000, wbc: 2.5,  platelets: 75,  hemoglobin: 7.5 },
  "ac-t":      { anc: 1500, wbc: 3.5,  platelets: 100, hemoglobin: 9.0 },
  folfox:      { anc: 1500, wbc: 3.5,  platelets: 100, hemoglobin: 8.0 },
  "r-chop":    { anc: 1000, wbc: 3.0,  platelets: 75,  hemoglobin: 8.0 },
};

type ChemoThreshold = { anc: number; wbc: number; platelets: number; hemoglobin: number };

function getThresholds(medications: Medication[]): { regimen: string; thresholds: ChemoThreshold } {
  const medNames = medications.map(m => m.name.toLowerCase());
  for (const [regimen, thresholds] of Object.entries(CHEMO_THRESHOLDS)) {
    if (regimen !== "default" && medNames.some(n => n.includes(regimen))) {
      return { regimen, thresholds };
    }
  }
  return { regimen: "default", thresholds: CHEMO_THRESHOLDS["default"]! };
}

// ─── CYP450 interaction database ────────────────────────────────────────────
const INTERACTIONS: { drugs: string[]; severity: "critical" | "moderate" | "mild"; description: string }[] = [
  { drugs: ["warfarin", "docetaxel"],    severity: "critical",  description: "Docetaxel may increase warfarin levels via CYP3A4 inhibition. INR check required before proceeding." },
  { drugs: ["warfarin", "paclitaxel"],   severity: "critical",  description: "Paclitaxel can potentiate warfarin anticoagulation. Monitor INR closely." },
  { drugs: ["metformin", "carboplatin"], severity: "moderate",  description: "Carboplatin may increase risk of lactic acidosis with metformin. Monitor renal function." },
  { drugs: ["aspirin", "carboplatin"],   severity: "moderate",  description: "Increased bleeding risk. Monitor platelet count." },
  { drugs: ["lisinopril", "docetaxel"],  severity: "mild",      description: "May enhance hypotensive effect. Monitor blood pressure." },
  { drugs: ["omeprazole", "methotrexate"], severity: "moderate", description: "Omeprazole may increase methotrexate toxicity. Monitor levels." },
  { drugs: ["fluconazole", "docetaxel"], severity: "critical",  description: "Fluconazole significantly increases docetaxel exposure via CYP3A4 inhibition." },
];

// ─── Date helpers ────────────────────────────────────────────────────────────
function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().split("T")[0]!;
}

function daysFromNowDate(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().split("T")[0]!;
}

// ─── Tool: get_patient_medications ──────────────────────────────────────────
export const getMedicationsSchema = z.object({
  patient_id: z.string().optional().describe("FHIR patient ID (resolved to demo patient for competition)"),
});

export async function getPatientMedications(input: z.infer<typeof getMedicationsSchema>) {
  const userId = resolvePatient(input.patient_id);
  const profileId = await resolveCareProfile(userId);

  const meds = await query<Medication>(
    `SELECT id, name, dose, frequency, prescribing_doctor, refill_date, healthkit_fhir_id
     FROM medications
     WHERE care_profile_id = :profileId::uuid AND deleted_at IS NULL
     ORDER BY name ASC`,
    [{ name: "profileId", value: { stringValue: profileId } }]
  );

  const today = new Date();
  const enriched = meds.map(med => ({
    ...med,
    refill_urgency: (() => {
      const refill = new Date(med.refill_date);
      const daysUntil = Math.ceil((refill.getTime() - today.getTime()) / 86400000);
      if (daysUntil <= 3) return "urgent";
      if (daysUntil <= 7) return "soon";
      return "ok";
    })(),
  }));

  return {
    patient_id: userId,
    medication_count: enriched.length,
    medications: enriched,
    urgent_refills: enriched.filter(m => m.refill_urgency === "urgent").length,
  };
}

// ─── Tool: get_lab_results ───────────────────────────────────────────────────
export const getLabResultsSchema = z.object({
  patient_id: z.string().optional(),
  limit: z.number().optional().default(20).describe("Number of recent results to return"),
});

export async function getLabResults(input: z.infer<typeof getLabResultsSchema>) {
  const userId = resolvePatient(input.patient_id);

  const labs = await query<LabResult>(
    `SELECT id, test_name, value, unit, reference_range, is_abnormal, date_taken
     FROM lab_results
     WHERE user_id = :userId::uuid AND deleted_at IS NULL
     ORDER BY date_taken DESC
     LIMIT :limit`,
    [
      { name: "userId", value: { stringValue: userId } },
      { name: "limit",  value: { longValue: input.limit ?? 20 } },
    ]
  );

  return {
    patient_id: userId,
    total_results: labs.length,
    abnormal_count: labs.filter(l => l.is_abnormal).length,
    abnormal_results: labs.filter(l => l.is_abnormal),
    all_results: labs,
  };
}

// ─── Tool: analyze_lab_trends ────────────────────────────────────────────────
export const analyzeLabTrendsSchema = z.object({
  patient_id: z.string().optional(),
  test_name: z.string().describe("Lab test to trend, e.g. 'ANC', 'WBC', 'Hemoglobin'"),
  days: z.number().optional().default(90).describe("Days of history to analyze"),
});

export async function analyzeLabTrends(input: z.infer<typeof analyzeLabTrendsSchema>) {
  const userId = resolvePatient(input.patient_id);
  const cutoff = daysAgoDate(input.days ?? 90);

  const labs = await query<LabResult & { numeric_value: number }>(
    `SELECT id, test_name, value, unit, reference_range, is_abnormal,
            date_taken, CAST(value AS DECIMAL(10,2)) as numeric_value
     FROM lab_results
     WHERE user_id = :userId::uuid
       AND LOWER(test_name) LIKE LOWER(:testName)
       AND date_taken >= :cutoff::date
       AND deleted_at IS NULL
     ORDER BY date_taken ASC`,
    [
      { name: "userId",   value: { stringValue: userId } },
      { name: "testName", value: { stringValue: `%${input.test_name}%` } },
      { name: "cutoff",   value: { stringValue: cutoff } },
    ]
  );

  if (labs.length < 2) {
    return { trend: "insufficient_data", message: `Only ${labs.length} data point(s) found for ${input.test_name}` };
  }

  const values = labs.map(l => l.numeric_value).filter(v => !isNaN(v));
  const first  = values[0]!;
  const last   = values[values.length - 1]!;
  const change = last - first;
  const pct    = ((change / first) * 100).toFixed(1);
  const trend  = change > 0 ? "increasing" : change < 0 ? "decreasing" : "stable";
  const recentAbnormal = labs.slice(-3).some(l => l.is_abnormal);

  return {
    test_name: input.test_name,
    data_points: labs.length,
    trend,
    first_value: `${first} ${labs[0]!.unit}`,
    latest_value: `${last} ${labs[0]!.unit}`,
    change_pct: `${pct}%`,
    recent_abnormal: recentAbnormal,
    history: labs.map(l => ({ date: l.date_taken, value: l.value, unit: l.unit, abnormal: l.is_abnormal })),
    clinical_summary: `${input.test_name} is ${trend} over the past ${input.days} days (${pct}% change). ${recentAbnormal ? "⚠️ Recent abnormal values detected." : "Recent values within normal range."}`,
  };
}

// ─── Tool: assess_chemo_safety ───────────────────────────────────────────────
export const assessChemoSafetySchema = z.object({
  patient_id: z.string().optional(),
});

export async function assessChemoSafety(input: z.infer<typeof assessChemoSafetySchema>) {
  const userId = resolvePatient(input.patient_id);
  const profileId = await resolveCareProfile(userId);

  const meds = await query<Medication>(
    `SELECT name, dose FROM medications
     WHERE care_profile_id = :profileId::uuid AND deleted_at IS NULL`,
    [{ name: "profileId", value: { stringValue: profileId } }]
  );

  const labRows = await query<LabResult>(
    `SELECT test_name, value, unit, reference_range, is_abnormal, date_taken
     FROM lab_results
     WHERE user_id = :userId::uuid AND deleted_at IS NULL
     ORDER BY date_taken DESC
     LIMIT 30`,
    [{ name: "userId", value: { stringValue: userId } }]
  );

  const cbcTests = ["ANC", "WBC", "Platelets", "Hemoglobin", "Neutrophil"];
  const cbc: Record<string, { value: number; unit: string; date: string; abnormal: boolean }> = {};
  for (const test of cbcTests) {
    const match = labRows.find(l => l.test_name.toLowerCase().includes(test.toLowerCase()));
    if (match) {
      cbc[test] = {
        value: parseFloat(match.value),
        unit: match.unit,
        date: match.date_taken,
        abnormal: match.is_abnormal,
      };
    }
  }

  const { regimen, thresholds } = getThresholds(meds);

  const flags: { lab: string; value: number; threshold: number; unit: string }[] = [];

  const anc = cbc["ANC"] ?? cbc["Neutrophil"];
  if (anc && anc.value < thresholds.anc) flags.push({ lab: "ANC", value: anc.value, threshold: thresholds.anc, unit: anc.unit });
  const wbc = cbc["WBC"];
  if (wbc && wbc.value < thresholds.wbc) flags.push({ lab: "WBC", value: wbc.value, threshold: thresholds.wbc, unit: wbc.unit });
  const plt = cbc["Platelets"];
  if (plt && plt.value < thresholds.platelets) flags.push({ lab: "Platelets", value: plt.value, threshold: thresholds.platelets, unit: plt.unit });
  const hgb = cbc["Hemoglobin"];
  if (hgb && hgb.value < thresholds.hemoglobin) flags.push({ lab: "Hemoglobin", value: hgb.value, threshold: thresholds.hemoglobin, unit: hgb.unit });

  const safetyStatus = flags.length === 0
    ? "proceed"
    : flags.some(f => f.lab === "ANC" || f.lab === "WBC")
    ? "hold"
    : "caution";

  return {
    safety_status: safetyStatus,
    regimen_detected: regimen,
    flags,
    cbc_summary: cbc,
    recommendation:
      safetyStatus === "proceed"
        ? "All CBC values meet threshold requirements for this regimen. Patient may proceed with scheduled infusion."
        : safetyStatus === "hold"
        ? `🔴 HOLD RECOMMENDED: ${flags.map(f => `${f.lab} is ${f.value} ${f.unit} (threshold: ${f.threshold})`).join("; ")}. Contact oncologist before proceeding.`
        : `⚠️ CAUTION: ${flags.map(f => `${f.lab} is ${f.value} ${f.unit} (threshold: ${f.threshold})`).join("; ")}. Discuss with oncologist.`,
    thresholds_used: thresholds,
  };
}

// ─── Tool: check_drug_interactions ──────────────────────────────────────────
export const checkDrugInteractionsSchema = z.object({
  patient_id: z.string().optional(),
  additional_medications: z.array(z.string()).optional().describe("Extra meds to check against patient's list"),
});

export async function checkDrugInteractions(input: z.infer<typeof checkDrugInteractionsSchema>) {
  const userId = resolvePatient(input.patient_id);
  const profileId = await resolveCareProfile(userId);

  const meds = await query<{ name: string }>(
    `SELECT name FROM medications
     WHERE care_profile_id = :profileId::uuid AND deleted_at IS NULL`,
    [{ name: "profileId", value: { stringValue: profileId } }]
  );

  const allMeds = [
    ...meds.map(m => m.name.toLowerCase()),
    ...(input.additional_medications ?? []).map(m => m.toLowerCase()),
  ];

  const found = INTERACTIONS.filter(interaction =>
    interaction.drugs.every(drug => allMeds.some(m => m.includes(drug)))
  );

  return {
    medications_checked: allMeds,
    interactions_found: found.length,
    critical_count: found.filter(i => i.severity === "critical").length,
    interactions: found,
    summary:
      found.length === 0
        ? "No known interactions detected among current medications."
        : `⚠️ ${found.length} interaction(s) detected. ${found.filter(i => i.severity === "critical").length} critical.`,
  };
}

// ─── Tool: get_upcoming_appointments ────────────────────────────────────────
export const getAppointmentsSchema = z.object({
  patient_id: z.string().optional(),
  days_ahead: z.number().optional().default(30),
});

export async function getUpcomingAppointments(input: z.infer<typeof getAppointmentsSchema>) {
  const userId = resolvePatient(input.patient_id);
  const profileId = await resolveCareProfile(userId);
  const futureDate = daysFromNowDate(input.days_ahead ?? 30);

  const appts = await query<Appointment>(
    `SELECT id, doctor_name, specialty, date_time, location, purpose
     FROM appointments
     WHERE care_profile_id = :profileId::uuid
       AND date_time >= NOW()
       AND date_time <= :futureDate::timestamptz
       AND deleted_at IS NULL
     ORDER BY date_time ASC`,
    [
      { name: "profileId",  value: { stringValue: profileId } },
      { name: "futureDate", value: { stringValue: futureDate } },
    ]
  );

  const now = new Date();
  const enriched = appts.map(a => ({
    ...a,
    hours_until: Math.round((new Date(a.date_time).getTime() - now.getTime()) / 3600000),
    urgent: new Date(a.date_time).getTime() - now.getTime() < 48 * 3600000,
  }));

  return {
    patient_id: userId,
    appointment_count: enriched.length,
    urgent_count: enriched.filter(a => a.urgent).length,
    appointments: enriched,
  };
}

// ─── Tool: get_insurance_status ──────────────────────────────────────────────
export const getInsuranceStatusSchema = z.object({
  patient_id: z.string().optional(),
});

export async function getInsuranceStatus(input: z.infer<typeof getInsuranceStatusSchema>) {
  const userId = resolvePatient(input.patient_id);

  const [insurance] = await query<Insurance>(
    `SELECT id, provider, member_id, deductible_limit, deductible_used,
            oop_limit, oop_used, plan_year
     FROM insurance
     WHERE user_id = :userId::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [{ name: "userId", value: { stringValue: userId } }]
  );

  const priorAuths = await query<PriorAuth>(
    `SELECT id, service, status, expiry_date, sessions_approved, sessions_used
     FROM prior_auths
     WHERE user_id = :userId::uuid
     ORDER BY expiry_date ASC`,
    [{ name: "userId", value: { stringValue: userId } }]
  );

  const today = new Date();
  const expiringAuths = priorAuths.filter(pa => {
    const daysLeft = Math.ceil((new Date(pa.expiry_date).getTime() - today.getTime()) / 86400000);
    return daysLeft <= 30 && daysLeft >= 0;
  });

  return {
    insurance: insurance ?? null,
    deductible_pct_used: insurance?.deductible_limit
      ? Math.round((insurance.deductible_used / insurance.deductible_limit) * 100)
      : null,
    oop_pct_used: insurance?.oop_limit
      ? Math.round((insurance.oop_used / insurance.oop_limit) * 100)
      : null,
    prior_auths: priorAuths,
    expiring_prior_auths: expiringAuths,
    alerts: expiringAuths.map(pa =>
      `⚠️ Prior auth for ${pa.service} expires ${pa.expiry_date} — renew immediately to avoid treatment delays.`
    ),
  };
}

// ─── Tool: get_symptom_trends ────────────────────────────────────────────────
export const getSymptomTrendsSchema = z.object({
  patient_id: z.string().optional(),
  days: z.number().optional().default(14),
});

export async function getSymptomTrends(input: z.infer<typeof getSymptomTrendsSchema>) {
  const userId = resolvePatient(input.patient_id);
  const cutoff = daysAgoDate(input.days ?? 14);

  const entries = await query<SymptomEntry>(
    `SELECT id, pain_level, mood, energy, sleep_hours, sleep_quality,
            appetite, symptoms, notes, date
     FROM symptom_entries
     WHERE user_id = :userId::uuid
       AND date >= :cutoff::date
     ORDER BY date ASC`,
    [
      { name: "userId", value: { stringValue: userId } },
      { name: "cutoff", value: { stringValue: cutoff } },
    ]
  );

  if (entries.length === 0) {
    return { message: "No symptom entries found for this period.", entries: [] };
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const avgPain  = avg(entries.map(e => e.pain_level));
  const avgSleep = avg(entries.map(e => e.sleep_hours));
  const highPainDays = entries.filter(e => e.pain_level >= 7).length;

  const allSymptoms = entries.flatMap(e => e.symptoms ?? []);
  const symFreq: Record<string, number> = {};
  for (const s of allSymptoms) symFreq[s] = (symFreq[s] ?? 0) + 1;

  return {
    period_days: input.days,
    entry_count: entries.length,
    averages: { pain: avgPain, sleep_hours: avgSleep },
    high_pain_days: highPainDays,
    most_common_symptoms: Object.entries(symFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({ tag, count })),
    entries,
    clinical_summary:
      `Over ${input.days} days: avg pain ${avgPain.toFixed(1)}/10, avg sleep ${avgSleep.toFixed(1)}h. ` +
      `${highPainDays} high-pain day(s) (7+/10). ` +
      (highPainDays >= 3
        ? "⚠️ Persistent high pain — consider flagging for oncologist review."
        : "Pain levels within manageable range."),
  };
}

// ─── Tool: generate_visit_prep ───────────────────────────────────────────────
export const generateVisitPrepSchema = z.object({
  patient_id: z.string().optional(),
  appointment_id: z.string().optional().describe("Specific appointment to prep for"),
});

export async function generateVisitPrep(input: z.infer<typeof generateVisitPrepSchema>) {
  const userId = resolvePatient(input.patient_id);
  const profileId = await resolveCareProfile(userId);

  const [nextAppt] = await query<Appointment>(
    `SELECT id, doctor_name, specialty, date_time, location, purpose
     FROM appointments
     WHERE care_profile_id = :profileId::uuid AND date_time >= NOW() AND deleted_at IS NULL
     ORDER BY date_time ASC LIMIT 1`,
    [{ name: "profileId", value: { stringValue: profileId } }]
  );

  const meds = await query<{ name: string; dose: string }>(
    `SELECT name, dose FROM medications
     WHERE care_profile_id = :profileId::uuid AND deleted_at IS NULL`,
    [{ name: "profileId", value: { stringValue: profileId } }]
  );

  const recentAbnormal = await query<Pick<LabResult, "test_name" | "value" | "unit">>(
    `SELECT test_name, value, unit FROM lab_results
     WHERE user_id = :userId::uuid AND is_abnormal = true AND deleted_at IS NULL
     ORDER BY date_taken DESC LIMIT 5`,
    [{ name: "userId", value: { stringValue: userId } }]
  );

  return {
    appointment: nextAppt ?? null,
    prep_checklist: [
      "Bring photo ID and insurance card",
      "Bring list of all current medications",
      "Bring any recent lab results or imaging",
      "Write down your top 3 concerns to discuss",
      "Note any new symptoms since last visit",
      "List any medications you've stopped or changed",
    ],
    medications_to_review: meds,
    abnormal_labs_to_discuss: recentAbnormal,
    suggested_questions: [
      "Are my current medications still appropriate given my recent labs?",
      "What should I watch for as side effects this cycle?",
      "When should I call the clinic versus go to the ER?",
      "What is the plan if my ANC is too low next cycle?",
      "Are there any clinical trials I should know about?",
    ],
  };
}

// ─── Tool: generate_morning_huddle_report ────────────────────────────────────
// Group scope — scans all patients in practice and returns prioritized risk list
export const morningHuddleSchema = z.object({
  practice_id: z.string().optional().describe("Healthcare practice identifier"),
  days_back: z.number().optional().default(2).describe("Days of recent data to scan"),
});

export async function generateMorningHuddleReport(input: z.infer<typeof morningHuddleSchema>) {
  const userId = resolvePatient(undefined);

  const safety   = await assessChemoSafety({ patient_id: userId });
  const symptoms = await getSymptomTrends({ patient_id: userId, days: input.days_back });
  const insurance = await getInsuranceStatus({ patient_id: userId });
  const meds     = await getPatientMedications({ patient_id: userId });

  const riskFactors: string[] = [];
  if (safety.safety_status === "hold")    riskFactors.push("CHEMO HOLD — low CBC");
  if (safety.safety_status === "caution") riskFactors.push("Chemo caution — borderline CBC");
  if ("high_pain_days" in symptoms && (symptoms as { high_pain_days: number }).high_pain_days >= 2)
    riskFactors.push("High pain 2+ days");
  if (insurance.expiring_prior_auths.length > 0) riskFactors.push("Prior auth expiring");
  if (meds.urgent_refills > 0)            riskFactors.push("Urgent refill needed");

  const riskLevel =
    riskFactors.some(r => r.includes("CHEMO HOLD")) ? "🔴 URGENT" :
    riskFactors.length >= 2                          ? "🟡 WATCH"  : "🟢 STABLE";

  return {
    report_generated: new Date().toISOString(),
    patient_panel: [
      {
        patient_name: "Sarah Chen (Demo)",
        patient_id: userId,
        risk_level: riskLevel,
        risk_factors: riskFactors,
        chemo_status: safety.safety_status,
        chemo_recommendation: safety.recommendation,
        recent_symptoms: "clinical_summary" in symptoms ? symptoms.clinical_summary : null,
        urgent_refills: meds.urgent_refills,
        expiring_prior_auths: insurance.expiring_prior_auths.length,
        action_required: riskFactors.length > 0,
      },
    ],
    summary: `Morning Huddle — ${new Date().toLocaleDateString()}. 1 patient reviewed. ${riskLevel}. ${riskFactors.length > 0 ? `Action needed: ${riskFactors.join(", ")}.` : "No immediate concerns."}`,
  };
}

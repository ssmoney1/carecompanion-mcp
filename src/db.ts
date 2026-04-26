import { RDSDataClient, ExecuteStatementCommand, SqlParameter } from "@aws-sdk/client-rds-data";

const rdsClient = new RDSDataClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const resourceArn = process.env.AWS_RESOURCE_ARN!;
const secretArn = process.env.AWS_SECRET_ARN!;

// ─── Demo patient ID — always routes to synthetic Sarah for the hackathon ───
// NEVER change this to a real user ID in the competition submission
export const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "demo-sarah-001";

// ─── Core query helper ───────────────────────────────────────────────────────
export async function query<T = Record<string, unknown>>(
  sql: string,
  parameters: SqlParameter[] = []
): Promise<T[]> {
  const command = new ExecuteStatementCommand({
    resourceArn,
    secretArn,
    database: "carecompanion",
    sql,
    parameters,
    formatRecordsAs: "JSON",
  });

  const result = await rdsClient.send(command);

  if (!result.formattedRecords) return [];

  try {
    return JSON.parse(result.formattedRecords) as T[];
  } catch {
    return [];
  }
}

// ─── Resolve patient — always returns demo user for hackathon ────────────────
export function resolvePatient(_incomingPatientId?: string): string {
  // Competition rule: all data must be synthetic — never expose real PHI
  return DEMO_USER_ID;
}

// ─── Resolve care profile — medications/appointments use care_profile_id ─────
// Cached after first lookup to avoid per-request round-trips
let _cachedProfileId: string | null = null;

export async function resolveCareProfile(userId: string): Promise<string> {
  if (_cachedProfileId) return _cachedProfileId;

  const rows = await query<{ id: string }>(
    `SELECT id FROM care_profiles WHERE user_id = :userId::uuid LIMIT 1`,
    [{ name: "userId", value: { stringValue: userId } }]
  );

  _cachedProfileId = rows[0]?.id ?? userId;
  return _cachedProfileId;
}

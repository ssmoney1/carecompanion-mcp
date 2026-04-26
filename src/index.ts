import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { extractFhirContext } from "./fhir.js";
import {
  getMedicationsSchema,        getPatientMedications,
  getLabResultsSchema,         getLabResults,
  analyzeLabTrendsSchema,      analyzeLabTrends,
  assessChemoSafetySchema,     assessChemoSafety,
  checkDrugInteractionsSchema, checkDrugInteractions,
  getAppointmentsSchema,       getUpcomingAppointments,
  getInsuranceStatusSchema,    getInsuranceStatus,
  getSymptomTrendsSchema,      getSymptomTrends,
  generateVisitPrepSchema,     generateVisitPrep,
  morningHuddleSchema,         generateMorningHuddleReport,
} from "./tools.js";

// ─── Factory: fresh McpServer per request (prevents transport collision) ─────
function createMcpServer(): McpServer {
  const s = new McpServer({ name: "carecompanion-oncology", version: "1.0.0" });

  s.registerTool("get_patient_medications", {
    description: "Retrieves the complete active medication list for a cancer patient including dosages, frequencies, refill dates, and urgency flags. Identifies medications due for refill within 3 days.",
    inputSchema: getMedicationsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getPatientMedications(input), null, 2) }],
  }));

  s.registerTool("get_lab_results", {
    description: "Retrieves recent lab results for a patient including CBC, metabolic panels, and tumor markers. Flags abnormal values.",
    inputSchema: getLabResultsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getLabResults(input), null, 2) }],
  }));

  s.registerTool("analyze_lab_trends", {
    description: "Analyzes the trend of a specific lab value (e.g. ANC, WBC, Hemoglobin, CA-125) over time. Returns trend direction, percent change, and clinical summary.",
    inputSchema: analyzeLabTrendsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await analyzeLabTrends(input), null, 2) }],
  }));

  s.registerTool("assess_chemo_safety", {
    description: "Determines whether a cancer patient is safe to proceed with their next chemotherapy infusion based on their latest CBC values and regimen-specific nadir thresholds. Returns proceed, caution, or hold recommendation with detailed reasoning.",
    inputSchema: assessChemoSafetySchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await assessChemoSafety(input), null, 2) }],
  }));

  s.registerTool("check_drug_interactions", {
    description: "Checks a patient's active medication list for known drug interactions with awareness of CYP450 pathways. Particularly important for oncology patients on chemotherapy regimens. Returns interactions by severity: critical, moderate, or mild.",
    inputSchema: checkDrugInteractionsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await checkDrugInteractions(input), null, 2) }],
  }));

  s.registerTool("get_upcoming_appointments", {
    description: "Retrieves upcoming medical appointments for a patient within a specified time window. Flags appointments within 48 hours as urgent.",
    inputSchema: getAppointmentsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getUpcomingAppointments(input), null, 2) }],
  }));

  s.registerTool("get_insurance_status", {
    description: "Returns a patient's insurance coverage details including deductible and out-of-pocket progress, plus prior authorization status with expiry alerts for any auths expiring within 30 days.",
    inputSchema: getInsuranceStatusSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getInsuranceStatus(input), null, 2) }],
  }));

  s.registerTool("get_symptom_trends", {
    description: "Returns a patient's self-reported symptom trends over a specified period including pain levels, mood, energy, sleep quality, and appetite. Flags concerning patterns such as persistent high pain.",
    inputSchema: getSymptomTrendsSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getSymptomTrends(input), null, 2) }],
  }));

  s.registerTool("generate_visit_prep", {
    description: "Generates a comprehensive visit preparation package for a patient's next appointment including medications to review, abnormal labs to discuss, and suggested questions for the oncologist.",
    inputSchema: generateVisitPrepSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await generateVisitPrep(input), null, 2) }],
  }));

  s.registerTool("generate_morning_huddle_report", {
    description: "Generates a proactive morning huddle report scanning all oncology patients and returning a risk-prioritized list of who needs attention today. Combines self-reported symptom data with lab values to surface patients the EHR would not flag. Operates at group/panel scope.",
    inputSchema: morningHuddleSchema.shape,
  }, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await generateMorningHuddleReport(input), null, 2) }],
  }));

  return s;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "carecompanion-oncology", version: "1.0.0" }));
    return;
  }

  const fhirCtx = extractFhirContext(req.headers as Record<string, string>);
  console.error(`[MCP] Request — Patient: ${fhirCtx.patientId ?? "none"} | FHIR URL: ${fhirCtx.serverUrl || "none"}`);

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({});

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
});

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3001", 10);

httpServer.listen(PORT, () => {
  console.error(`✅ CareCompanion MCP Server running on port ${PORT}`);
  console.error(`   Health check: http://localhost:${PORT}/health`);
  console.error(`   MCP endpoint: http://localhost:${PORT}/`);
  console.error(`   Tools registered: 10`);
  console.error(`   Demo patient: ${process.env.DEMO_USER_ID ?? "demo-sarah-001"}`);
});

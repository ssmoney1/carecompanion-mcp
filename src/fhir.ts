// Extracts FHIR context from Prompt Opinion headers
// Per spec: X-FHIR-Server-URL, X-FHIR-Access-Token, X-Patient-ID

export interface FhirContext {
  serverUrl: string;
  accessToken: string | undefined;
  patientId: string | undefined;
}

export function extractFhirContext(
  headers: Record<string, string | string[] | undefined>
): FhirContext {
  const get = (key: string): string | undefined => {
    const val = headers[key.toLowerCase()] ?? headers[key];
    return Array.isArray(val) ? val[0] : val;
  };

  return {
    serverUrl: get("X-FHIR-Server-URL") ?? "",
    accessToken: get("X-FHIR-Access-Token"),
    patientId: get("X-Patient-ID"),
  };
}
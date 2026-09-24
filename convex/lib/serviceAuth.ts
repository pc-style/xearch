/** Never fall back to a credential for the other service capability. */
export function serviceToken(
  capability: "search" | "capture",
  env: Record<string, string | undefined> = process.env,
) {
  const name = capability === "search" ? "SEARCH_SERVICE_TOKEN" : "RAW_CAPTURE_TOKEN";

  return env[name] ?? env.DATA_SERVICE_TOKEN;
}

/** Phase 1 organizations workspace. Off unless explicitly enabled; must match AIMO_FEATURE_ORGS
 *  on aimo-api (with the API flag off, the workspace would only ever see 404s). */
export function orgsEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_AIMO_FEATURE_ORGS;
  return v === "1" || v === "true";
}

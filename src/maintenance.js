// App-level protection for the new release. Old deployments additionally need
// a project-wide Firewall rule: their code cannot read this release's flag.
/** @param {Request} request @param {boolean} enabled */
export function maintenanceResponse(request, enabled) {
  if (!enabled) return null;
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/mcp') && !path.startsWith('/oauth')) return null;
  return Response.json({error:'maintenance'}, {status:503,headers:{'Cache-Control':'no-store','Retry-After':'300'}});
}

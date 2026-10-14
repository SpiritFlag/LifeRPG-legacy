import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticate, challenge, HttpError, json, oauthRoute, readBody } from './oauth.js';
import { createMcpServer } from './tools.js';

/** @param {import('./database.js').Database} db @param {import('./config.js').Config} config */
export function createApp(db, config) {
  /** @param {Request} request */
  return async function handle(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return json({server:'liferpg-mcp-experiment',status:'running'});
      const oauth = await oauthRoute(db,config,request);
      if (oauth) return oauth;
      if (path !== '/mcp') return json({error:'not_found'},404);
      const origin = request.headers.get('origin');
      if (origin && ![config.base,'https://chatgpt.com'].includes(origin)) return json({error:'invalid_origin'},403);
      if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin || config.base,'Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, MCP-Protocol-Version','Vary':'Origin'}});
      // This stateless server has no unsolicited events or sessions to delete.
      if (request.method !== 'POST') return new Response(null,{status:405,headers:{Allow:'POST, OPTIONS'}});
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'unsupported_media_type'},415);
      let body;
      try { body = JSON.parse(await readBody(request)); } catch (error) { if (error instanceof HttpError) throw error; return json({error:'invalid_json'},400); }
      if (Array.isArray(body)) return json({error:'batch_not_supported'},400);
      const discovery = ['initialize','tools/list','notifications/initialized','ping'].includes(body?.method);
      const identity = discovery ? null : await authenticate(db,config,request);
      if (!discovery && !identity) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store','WWW-Authenticate':challenge(config)}});
      const server = createMcpServer(db,config,identity);
      const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);
      try {
        const result = await transport.handleRequest(request,{parsedBody:body});
        // JSON response is complete before transport cleanup; no live SSE is retained.
        const text = await result.text();
        const headers = new Headers(result.headers);
        headers.set('Cache-Control','no-store');
        headers.set('X-Content-Type-Options','nosniff');
        if (origin) {headers.set('Access-Control-Allow-Origin',origin); headers.set('Vary','Origin');}
        return new Response(text || null,{status:result.status,headers});
      } finally { await server.close(); }
    } catch (error) {
      if (error instanceof HttpError) return json({error:error.message},error.status);
      console.error(JSON.stringify({type:'request_error',outcome:'internal_error'}));
      return json({error:'internal_error'},500);
    }
  };
}

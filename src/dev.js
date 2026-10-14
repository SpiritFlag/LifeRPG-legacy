import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { connectDatabase } from './database.js';

const config = readConfig();
const db = connectDatabase(process.env.DATABASE_URL || '');
const app = createApp(db,config);
const server = createServer(async (req,res) => {
  const request = new Request(new URL(req.url || '/',config.base),{method:req.method,headers:/** @type {HeadersInit} */ (req.headers),...(['GET','HEAD'].includes(req.method || '') ? {} : {body:/** @type {ReadableStream} */ (/** @type {unknown} */ (Readable.toWeb(req))),duplex:'half'})});
  const response = await app(request);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(Number(new URL(config.base).port || 3000),'127.0.0.1',() => console.info(`LifeRPG local MCP: ${config.resource}`));
process.on('SIGINT',() => server.close(() => { void db.close(); }));

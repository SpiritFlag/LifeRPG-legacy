import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

test('browser approval preserves same-origin POST and completes OAuth',async () => {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../migrations/001-experiment.sql',import.meta.url),'utf8'));
  const db = {query:(sql,values) => pg.query(sql,values),transaction:fn => pg.transaction(tx => fn({query:(sql,values) => tx.query(sql,values)}))};
  let app, postedOrigin;
  const server = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'POST') postedOrigin = req.headers.origin;
    const request = new Request(`http://localhost:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(req.method === 'POST' ? {body:Buffer.concat(chunks)} : {})});
    const response = await app(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://localhost:${server.address().port}`;
  const config = readConfig({PUBLIC_BASE_URL:base,OAUTH_CLIENT_SECRET:'test-client-secret-'.repeat(3),OWNER_LOGIN_KEY:'test-owner-key-'.repeat(3),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
  app = createApp(db,config);
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH ? {executablePath:process.env.BROWSER_EXECUTABLE_PATH} : {channel:'msedge'})});
    const page = await browser.newPage();
    const errors = [];
    page.on('console',message => {if (message.type() === 'error') errors.push(message.text().split("'")[0]);});
    // No real ChatGPT request, login, or account is touched by this isolated test.
    await page.route('https://chatgpt.com/**',route => route.fulfill({status:200,body:'OAuth callback intercepted by regression test'}));
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirects[0],response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'life.read life.write offline_access',state:'browser-regression',resource:config.resource});
    await page.goto(`${base}/oauth/authorize?${params}`);
    await page.locator('input[name="owner_key"]').fill(config.ownerKey);
    const posted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/oauth/authorize',{timeout:5000});
    await page.getByRole('button',{name:'연결 승인'}).click();
    const response = await posted.catch(error => {throw new Error(`Approval failed: Origin=${postedOrigin}, browser=${errors.join('; ')}`,{cause:error});});
    assert.equal(response.status(),303,`Browser form returned ${response.status()}, Origin=${postedOrigin}`);
    assert.equal(postedOrigin,base);
    const destination = new URL(response.headers().location);
    assert.equal(destination.searchParams.get('iss'),base);
    assert.equal(destination.searchParams.get('state'),'browser-regression');
    await page.waitForURL('https://chatgpt.com/**');
    assert.equal(await page.locator('body').textContent(),'OAuth callback intercepted by regression test');
    const tokenResponse = await app(new Request(`${base}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:destination.searchParams.get('code'),code_verifier:verifier,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirects[0],resource:config.resource})}));
    assert.equal(tokenResponse.status,200);
    console.info(JSON.stringify({browser:'Edge Chromium',form_origin:postedOrigin,approval_status:response.status(),token_exchange_status:tokenResponse.status}));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await pg.close();
  }
});

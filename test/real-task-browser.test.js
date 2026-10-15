import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startPreview } from '../scripts/preview-web.js';

test('task quests render escaped facts and repeat conditions in existing desktop/mobile views',async t=>{
  const preview=await startPreview(0);
  t.after(()=>preview.close());
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH ? {executablePath:process.env.BROWSER_EXECUTABLE_PATH} : {channel:'msedge'})});
  t.after(()=>browser.close());
  await preview.fixture.apply({mode:'advance',quest_changes:[
    {operation:'create_line',ref:'@task',line_key:'browser-task',title:'흩어진 길드 기록의 복원',description:'길드의 기록을 제자리로 돌려놓자.',real_task:'이번 주 서류 정리 <img src=x onerror="window.TASK_XSS=true">',status:'active',user_consent:true,reason:'Synthetic task'},
    {operation:'create_node',ref:'@walk',questline:'@task',node_key:'walk',kind:'quest',title:'숲길의 순찰자',real_task:'20분 산책',recurrence:'매일',status:'active',user_consent:true,reason:'Synthetic repeating task'},
  ]});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${preview.url}/#quests`);
  const card=page.locator('.quest-card').filter({hasText:'흩어진 길드 기록의 복원'});
  await card.waitFor();assert.ok((await card.innerText()).includes('이번 주 서류 정리 <img'));
  assert.ok((await card.innerText()).includes('일회성'));
  await card.click();
  await page.getByRole('heading',{name:'숲길의 순찰자',exact:true,level:4}).waitFor();
  assert.ok((await page.locator('.quest-node').filter({hasText:'숲길의 순찰자'}).innerText()).includes('반복 · 매일'));
  assert.equal(await page.evaluate(()=>window.TASK_XSS),undefined);
  await mkdir('.local/real-task-quests',{recursive:true});
  await page.screenshot({path:'.local/real-task-quests/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.screenshot({path:'.local/real-task-quests/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migration helper rejects pooled targets, unrelated databases and unknown migrations before connecting',()=>{
  const cases=[
    ['postgresql://fixture:fixture@fixture-pooler.neon.tech/liferpg_experiment','002-life-event-history.sql','verified direct endpoint'],
    ['postgresql://fixture:fixture@fixture.neon.tech/unrelated','002-life-event-history.sql','Refusing setup'],
    ['postgresql://fixture:fixture@fixture.neon.tech/liferpg_experiment','unknown.sql','explicit known migration'],
  ];
  for(const [url,file,message] of cases) {
    const result=spawnSync(process.execPath,['scripts/setup-db.js',file],{env:{...process.env,DATABASE_DIRECT_URL:url},encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);assert.ok(result.stderr.includes(message));assert.ok(!result.stderr.includes('ENOTFOUND'));
  }
});

test('008 preserves legacy story fields, versions and terminal states; defaults are one-time',async()=>{
  const pg=new PGlite();
  try {
    for(const file of ['001-experiment','002-life-event-history','003-gm-growth','004-questlines']) await pg.exec(await readFile(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
    const game='00000000-0000-4000-8000-000000000001',line='00000000-0000-4000-8000-000000000002';
    await pg.query("INSERT INTO games(id,owner_id,kind,revision,rules_version) VALUES($1,'migration-fixture','test',2,'growth-v1')",[game]);
    await pg.query("INSERT INTO questlines(id,game_id,line_key,title,description,goal,progress,ending,status,version) VALUES($1,$2,'legacy','Legacy','Description','Goal','Progress','Preserved ending','completed',3)",[line,game]);
    const before=(await pg.query('SELECT * FROM questlines')).rows[0];
    await pg.exec(await readFile(new URL('../migrations/008-real-task-quests.sql',import.meta.url),'utf8'));
    const {real_task,recurrence,...after}=(await pg.query('SELECT * FROM questlines')).rows[0];
    assert.deepEqual(after,before);assert.equal(real_task,'');assert.equal(recurrence,null);
    await assert.rejects(pg.query("UPDATE questlines SET recurrence='daily' WHERE id=$1",[line]),/questline_repeat_task/);
  } finally {await pg.close();}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

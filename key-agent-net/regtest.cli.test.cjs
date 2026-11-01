'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const file=path.join(__dirname,'regtest.cjs');
test('regtest runner help needs no Bitcoin Core',()=>{
  const r=spawnSync(process.execPath,[file,'--help'],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/--run-isolated/);
  assert.match(r.stdout,/regtest/);
});
test('runner refuses execution without explicit flag',()=>{
  const r=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,2);
  assert.match(r.stderr,/Usage/);
});
test('runner rejects misspelled or extra flags',()=>{
  for(const args of [['--run'],['--run-isolated','--help']]){
    const r=spawnSync(process.execPath,[file,...args],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,2);
  }
});

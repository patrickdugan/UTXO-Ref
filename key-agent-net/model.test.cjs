'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalize,assess,scenario,paretoOptions}=require('./model.cjs');
const fixture=require('./fixture.json');
const base=()=>({horizon:'one year',domains:[],
  agents:['a','b','c'].map(id=>({id,operator:id,domains:[],costUnits:1,compromiseProbability:.01,offlineProbability:.01})),
  vault:{id:'v',signers:['a','b','c'],threshold:2,clientId:'a'}});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,a+' vs '+b);
test('2-of-3 independent probability equals 3p^2 - 2p^3',()=>{
  const r=assess(base());
  near(r.unauthorizedSpendProbability,.000298);
  near(r.unavailableProbability,.000298);
  near(r.honestRekeyProbability,.9801**3+3*.9801**2*(1-.9801));
});
test('shared compromise domain gives 2% common-mode floor',()=>{
  const p=base();p.domains=[{id:'cloud',compromiseProbability:.02,offlineProbability:0}];
  p.agents.forEach(a=>a.domains=['cloud']);
  near(assess(p).unauthorizedSpendProbability,.02+.98*.000298);
});
test('two external custodians form an authorized quorum without the client',()=>{
  const r=assess(fixture);
  assert.equal(r.clientMandatory,false);
  assert.deepEqual(r.externalOnlyQuorums,[['custodian-a','custodian-b']]);
});
test('increased shared outage worsens liveness and safe rekey',()=>{
  const p=structuredClone(fixture),low=assess(p);
  p.domains.find(d=>d.id==='regional-cloud').offlineProbability=.8;
  const high=assess(p);
  assert.ok(high.unavailableProbability>low.unavailableProbability);
  assert.ok(high.honestRekeyProbability<low.honestRekeyProbability);
});
test('certain compromise, zero compromise and threshold boundaries',()=>{
  const p=base();p.agents.forEach(a=>a.compromiseProbability=0);
  near(assess(p).unauthorizedSpendProbability,0);
  p.agents[0].compromiseProbability=1;
  near(assess(p).unauthorizedSpendProbability,0);
  p.agents[1].compromiseProbability=1;
  near(assess(p).unauthorizedSpendProbability,1);
});
test('collusion, one lost signer, and liveness deadlock',()=>{
  const p=base();
  const theft=scenario(p,{compromisedAgents:['b','c'],offlineAgents:['a']});
  assert.equal(theft.canSteal,true);
  assert.equal(theft.canHonestRekey,false);
  const recovery=scenario(p,{offlineAgents:['b']});
  assert.equal(recovery.canHonestRekey,true);
  assert.equal(recovery.canSteal,false);
  assert.equal(scenario(p,{offlineAgents:['a','b']}).canHonestRekey,false);
});
test('shared domain compromise has precise membership',()=>{
  const state=scenario(fixture,{compromisedDomains:['domestic-cloud']});
  assert.deepEqual(state.compromised,['custodian-a']);
});
test('reject duplicate IDs, invalid rates, unknown domains, unknown incidents',()=>{
  const p=base();
  assert.throws(()=>normalize({...p,vault:{...p.vault,signers:['a','b','b']}}));
  assert.throws(()=>normalize({...p,agents:p.agents.map(a=>({...a,compromiseProbability:NaN}))}));
  assert.throws(()=>normalize({...p,agents:p.agents.map(a=>({...a,domains:['ghost']}))}));
  assert.throws(()=>scenario(p,{compromisedAgents:['ghost']}));
  assert.throws(()=>scenario(p,{offlineAgents:['a','a']}));
});
test('frontier is deterministic and every returned choice is non-dominated',()=>{
  const a=paretoOptions(fixture,{size:3,threshold:2}),b=paretoOptions(fixture,{size:3,threshold:2});
  assert.deepEqual(a,b);
  assert.equal(a.candidates,10);
  assert.ok(a.pareto.length>=1);
  const keys=['unauthorizedSpendProbability','unavailableProbability','costUnits'];
  for(const row of a.pareto)for(const other of a.pareto)if(other!==row){
    const dominates=keys.every(k=>other[k]<=row[k])&&keys.some(k=>other[k]<row[k]);
    assert.equal(dominates,false);
  }
});
test('no silent approximations when event space grows too large',()=>{
  const p=base();p.domains=Array.from({length:7},(_,i)=>({id:'d'+i,compromiseProbability:.01,offlineProbability:.01}));
  p.agents.forEach(a=>a.domains=p.domains.map(d=>d.id));
  assert.throws(()=>assess(p),/limited/);
});
test('same operator exclusion is explicit; full enumeration is opt-in',()=>{
  const p=structuredClone(fixture);
  p.agents[3].operator=p.agents[1].operator;
  assert.ok(paretoOptions(p,{size:3,threshold:2,requireDistinctOperators:false}).candidates>
    paretoOptions(p,{size:3,threshold:2}).candidates);
});

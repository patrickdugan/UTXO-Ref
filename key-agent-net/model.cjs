'use strict';
// Research-only exact finite-event model. No signing, keys, RPC, or broadcast.
const ID=/^[a-z][a-z0-9_.:-]{0,63}$/i;

function fail(x){throw new Error(x);}

function object(x,name){if(x===null||typeof x!=='object'||Array.isArray(x))fail(name+' must be object');return x;}

function id(x,name){if(typeof x!=='string'||!ID.test(x))fail(name+' must be a bounded identifier');return x;}

function probability(x,name){if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>1)fail(name+' must be a finite probability');return x;}

function integer(x,min,max,name){if(!Number.isSafeInteger(x)||x<min||x>max)fail(name+` must be ${min}..${max}`);return x;}

function distinct(xs,name){if(new Set(xs).size!==xs.length)fail(name+' must be unique');return xs;}

function normalize(input){
  const p=object(input,'profile');
  if(typeof p.horizon!=='string'||p.horizon.length<1||p.horizon.length>100)fail('horizon must name one probability window');
  if(!Array.isArray(p.domains)||p.domains.length>12)fail('domains must be an array <=12');
  const domains=p.domains.map((d,i)=>{object(d,`domains[${i}]`);return {
    id:id(d.id,`domains[${i}].id`),
    compromiseProbability:probability(d.compromiseProbability,`domains[${i}].compromiseProbability`),
    offlineProbability:probability(d.offlineProbability,`domains[${i}].offlineProbability`)
  };});
  distinct(domains.map(d=>d.id),'domains');
  const knownDomains=new Set(domains.map(d=>d.id));
  if(!Array.isArray(p.agents)||p.agents.length<2||p.agents.length>12)fail('agents must contain 2..12 entries');
  const agents=p.agents.map((a,i)=>{
    object(a,`agents[${i}]`);
    if(!Array.isArray(a.domains))fail(`agents[${i}].domains must be an array`);
    const ds=distinct(a.domains.map(d=>id(d,`agents[${i}].domains[]`)),`agents[${i}].domains`);
    if(ds.some(d=>!knownDomains.has(d)))fail(`agents[${i}] references an unknown domain`);
    return {id:id(a.id,`agents[${i}].id`),operator:id(a.operator,`agents[${i}].operator`),domains:ds,
      costUnits:integer(a.costUnits,0,1_000_000_000,`agents[${i}].costUnits`),
      compromiseProbability:probability(a.compromiseProbability,`agents[${i}].compromiseProbability`),
      offlineProbability:probability(a.offlineProbability,`agents[${i}].offlineProbability`)};
  });
  distinct(agents.map(a=>a.id),'agent IDs');
  const vault=object(p.vault,'vault');
  if(!Array.isArray(vault.signers)||vault.signers.length<2||vault.signers.length>10)fail('vault.signers must contain 2..10 agents');
  const signers=distinct(vault.signers.map(x=>id(x,'vault.signers[]')),'vault.signers');
  const byId=new Map(agents.map(a=>[a.id,a]));
  if(signers.some(x=>!byId.has(x)))fail('vault references an unknown agent');
  const threshold=integer(vault.threshold,2,signers.length,'vault.threshold');
  const clientId=vault.clientId==null?null:id(vault.clientId,'vault.clientId');
  if(clientId!==null&&!signers.includes(clientId))fail('vault.clientId must be a signer');
  const usedDomains=new Set(signers.flatMap(x=>byId.get(x).domains));
  if(signers.length+usedDomains.size>9)fail('exact enumeration limited to nine signer/domain sources');
  return {horizon:p.horizon,domains,agents,vault:{id:id(vault.id,'vault.id'),threshold,signers,clientId}};
}

function combinations(xs,k){
  const out=[];
  function walk(start,chosen){if(chosen.length===k){out.push(chosen);return;}
    for(let i=start;i<=xs.length-(k-chosen.length);i++)walk(i+1,[...chosen,xs[i]]);
  }walk(0,[]);return out;
}

function popcount(mask){let n=0;while(mask){mask &= mask-1;n++;}return n;}

function eventsFor(p,kind){
  const ids=p.vault.signers,byId=new Map(p.agents.map(a=>[a.id,a]));
  const property=kind==='compromise'?'compromiseProbability':'offlineProbability';
  const events=ids.map((x,i)=>({kind,rate:byId.get(x)[property],mask:1<<i}));
  for(const domain of p.domains){
    let mask=0;
    ids.forEach((x,i)=>{if(byId.get(x).domains.includes(domain.id))mask|=1<<i;});
    if(mask)events.push({kind,rate:domain[property],mask});
  }
  return events;
}

function exact(events,n,predicate){
  if(events.length>18)fail('exact model only supports 18 event bits');
  const full=(1<<n)-1;
  let total=0;
  for(let choice=0;choice<(1<<events.length);choice++){
    let mass=1,compromised=0,offline=0;
    for(let j=0;j<events.length;j++){
      const e=events[j],fired=(choice&(1<<j))!==0;
      mass*=fired?e.rate:1-e.rate;
      if(fired){if(e.kind==='compromise')compromised|=e.mask;else offline|=e.mask;}
    }
    if(mass&&predicate({full,compromised,offline,honestOnline:full&~(offline|compromised)}))total+=mass;
  }
  return Math.max(0,Math.min(1,total));
}

function assess(input){
  const p=normalize(input),n=p.vault.signers.length,k=p.vault.threshold;
  const theft=eventsFor(p,'compromise'),outages=eventsFor(p,'offline');
  const quorums=combinations(p.vault.signers,k);
  const externalOnlyQuorums=p.vault.clientId===null?[]:quorums.filter(q=>!q.includes(p.vault.clientId));
  return {
    vaultId:p.vault.id,horizon:p.horizon,signers:[...p.vault.signers],threshold:k,
    unauthorizedSpendProbability:exact(theft,n,s=>popcount(s.compromised)>=k),
    unavailableProbability:exact(outages,n,s=>popcount(s.full&~s.offline)<k),
    honestRekeyProbability:exact([...theft,...outages],n,s=>popcount(s.honestOnline)>=k),
    externalOnlyQuorums,clientMandatory:p.vault.clientId===null?null:externalOnlyQuorums.length===0
  };
}

function scenario(input,changes={}){
  const p=normalize(input),c=object(changes,'scenario'),byId=new Map(p.agents.map(a=>[a.id,a]));
  function choose(key,valid){
    const xs=c[key]??[];
    if(!Array.isArray(xs))fail(key+' must be an array');
    const unique=distinct(xs.map(x=>id(x,key)),key);
    if(unique.some(x=>!valid.has(x)))fail(key+' references an unknown actor');
    return new Set(unique);
  }
  const signers=new Set(p.vault.signers),domains=new Set(p.domains.map(d=>d.id));
  const bad=choose('compromisedAgents',signers),down=choose('offlineAgents',signers);
  const badD=choose('compromisedDomains',domains),downD=choose('offlineDomains',domains);
  const compromised=[],offline=[],honestOnline=[];
  for(const x of p.vault.signers){
    const a=byId.get(x),c=bad.has(x)||a.domains.some(d=>badD.has(d)),o=down.has(x)||a.domains.some(d=>downD.has(d));
    if(c)compromised.push(x);
    if(o)offline.push(x);
    if(!c&&!o)honestOnline.push(x);
  }
  const canSteal=compromised.length>=p.vault.threshold,canHonestRekey=honestOnline.length>=p.vault.threshold;
  return {vaultId:p.vault.id,compromised,offline,honestOnline,canSteal,canHonestRekey,contested:canSteal&&canHonestRekey};
}

function paretoOptions(input,options={}){
  const p=normalize(input),o=object(options,'options');
  const size=integer(o.size??p.vault.signers.length,2,Math.min(6,p.agents.length),'size');
  const threshold=integer(o.threshold??p.vault.threshold,2,size,'threshold');
  const uniqueOperator=o.requireDistinctOperators!==false,byId=new Map(p.agents.map(a=>[a.id,a]));
  const choices=combinations(p.agents.map(a=>a.id),size);
  if(choices.length>500)fail('too many combinations');
  const rows=[];
  for(const signers of choices){
    if(uniqueOperator&&new Set(signers.map(x=>byId.get(x).operator)).size!==size)continue;
    const q={...p,vault:{...p.vault,signers,threshold,clientId:signers.includes(p.vault.clientId)?p.vault.clientId:null}};
    const report=assess(q);
    rows.push({...report,costUnits:signers.reduce((sum,x)=>sum+byId.get(x).costUnits,0)});
  }
  const keys=['unauthorizedSpendProbability','unavailableProbability','costUnits'];
  function dominates(a,b){return keys.every(k=>a[k]<=b[k])&&keys.some(k=>a[k]<b[k]);}
  const frontier=rows.filter(r=>!rows.some(s=>r!==s&&dominates(s,r)));
  frontier.sort((a,b)=>a.unauthorizedSpendProbability-b.unauthorizedSpendProbability||
    a.unavailableProbability-b.unavailableProbability||a.costUnits-b.costUnits);
  return {candidates:rows.length,pareto:frontier};
}

module.exports={normalize,assess,scenario,paretoOptions};

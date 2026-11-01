'use strict';
const fixture=require('./fixture.json');
const {assess,scenario,paretoOptions}=require('./model.cjs');
function run(){
  const report={
    status:'HYPOTHETICAL_MODEL_ONLY',
    assumptions:'All independent agent events and domain events are Bernoulli draws over the fixed fixture horizon; shared domains affect all member agents.',
    vault:assess(fixture),
    incidents:{
      oneExternalSignerOffline:scenario(fixture,{offlineAgents:['custodian-a']}),
      externalCustodiansCollude:scenario(fixture,{compromisedAgents:['custodian-a','custodian-b']}),
      commonInfrastructureCompromise:scenario(fixture,{compromisedDomains:['domestic-cloud']})
    },
    signerChoice:paretoOptions(fixture,{size:3,threshold:2})
  };
  if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
  else{
    console.log('KeyAgentNet v0: hypothetical threshold model (no signatures or RPC)');
    console.log('Vault:',report.vault.vaultId,report.vault.signers.join(' + '));
    for(const name of ['unauthorizedSpendProbability','unavailableProbability','honestRekeyProbability'])
      console.log('  '+name+': '+(100*report.vault[name]).toFixed(5)+'%');
    console.log('External-only signing quorums:',JSON.stringify(report.vault.externalOnlyQuorums));
    console.log('Candidate signer sets:',report.signerChoice.candidates,'Pareto sets:',report.signerChoice.pareto.length);
    for(const row of report.signerChoice.pareto)
      console.log('  '+row.signers.join(', ')+' | compromise='+(100*row.unauthorizedSpendProbability).toFixed(5)+'% | outage='+(100*row.unavailableProbability).toFixed(5)+'% | cost units='+row.costUnits);
  }
}
if(require.main===module)run();
module.exports={run};

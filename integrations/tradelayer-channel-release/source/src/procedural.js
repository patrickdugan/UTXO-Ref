const db = require('./db');

const PROCEDURAL_STATES = {
  TEMPLATE: 'TEMPLATE',
  FUNDED: 'FUNDED',
  OPEN: 'OPEN',
  SETTLED: 'SETTLED',
  CLOSED: 'CLOSED',
  DISPUTED: 'DISPUTED'
};

class ProceduralRegistry {
  static async _base() {
    return db.getDatabase('procedural');
  }

  static async upsertTemplate(templateId, data = {}) {
    const base = await this._base();
    const key = `template-${templateId}`;
    const doc = { _id: key, type: 'template', templateId, ...data };
    await base.updateAsync({ _id: key }, { $set: doc }, { upsert: true });
    return doc;
  }

  static async upsertContract(contractId, templateId, state = PROCEDURAL_STATES.OPEN, data = {}) {
    const base = await this._base();
    const key = `contract-${contractId}`;
    const doc = { _id: key, type: 'contract', contractId, templateId, state, ...data };
    await base.updateAsync({ _id: key }, { $set: doc }, { upsert: true });
    return doc;
  }

  static async getContract(contractId) {
    const base = await this._base();
    return base.findOneAsync({ _id: `contract-${contractId}` });
  }

  static async getTemplate(templateId) {
    const base = await this._base();
    return base.findOneAsync({ _id: `template-${templateId}` });
  }

  static _normalizeHash(hash) {
    return String(hash || '').trim().toLowerCase();
  }

  static async ensureIssuanceContext(templateId, contractId, settlementState = '', dlcHash = '') {
    if (!templateId || !contractId) {
      return { valid: false, reason: 'Missing dlcTemplateId/dlcContractId for procedural token' };
    }
    if (!dlcHash) {
      return { valid: false, reason: 'Missing dlcHash for procedural token issuance' };
    }
    const template = await this.getTemplate(templateId);
    if (!template) {
      return { valid: false, reason: 'Unknown DLC template id for procedural token' };
    }
    const expectedHash = this._normalizeHash(template.templateHash || template.dlcHash || template.hash);
    if (!expectedHash) {
      return { valid: false, reason: 'DLC template missing published hash reference' };
    }
    if (this._normalizeHash(dlcHash) !== expectedHash) {
      return { valid: false, reason: 'DLC template hash mismatch' };
    }
    const contract = await this.getContract(contractId);
    if (!contract) return { valid: false, reason: 'Unknown DLC contract id for procedural token' };
    if (String(contract.templateId) !== String(templateId)) {
      return { valid: false, reason: 'DLC template/contract mismatch' };
    }
    const currentState = String(contract.state || '').toUpperCase();
    if (!['FUNDED', 'OPEN'].includes(currentState)) {
      return { valid: false, reason: `DLC contract state ${currentState} not mintable` };
    }
    if (settlementState && String(settlementState).toUpperCase() !== currentState) {
      return { valid: false, reason: 'Provided settlementState does not match DLC contract state' };
    }
    return { valid: true, contract, template };
  }

  static async ensureRedemptionContext(templateId, contractId, settlementState = '') {
    if (!templateId || !contractId) {
      return { valid: false, reason: 'Missing dlcTemplateId/dlcContractId for procedural redemption' };
    }
    const contract = await this.getContract(contractId);
    if (!contract) return { valid: false, reason: 'Unknown DLC contract id for procedural redemption' };
    if (String(contract.templateId) !== String(templateId)) {
      return { valid: false, reason: 'DLC template/contract mismatch' };
    }
    const currentState = String(contract.state || '').toUpperCase();
    if (!['SETTLED', 'CLOSED'].includes(currentState)) {
      return { valid: false, reason: `DLC contract state ${currentState} not redeemable` };
    }
    if (settlementState && String(settlementState).toUpperCase() !== currentState) {
      return { valid: false, reason: 'Provided settlementState does not match DLC contract state' };
    }
    return { valid: true, contract };
  }

  static async transitionContract(contractId, nextState, metadata = {}) {
    const base = await this._base();
    const key = `contract-${contractId}`;
    const prev = await base.findOneAsync({ _id: key });
    const merged = {
      ...(prev || { _id: key, type: 'contract', contractId }),
      ...metadata,
      state: String(nextState || '').toUpperCase()
    };
    await base.updateAsync({ _id: key }, { $set: merged }, { upsert: true });
    return merged;
  }
}

module.exports = { ProceduralRegistry, PROCEDURAL_STATES };


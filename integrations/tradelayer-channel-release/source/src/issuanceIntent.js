const db = require('./db.js');

const IssuanceIntent = {
  async recordIntent(txid, intent) {
    if (!txid) throw new Error('txid is required');
    const base = await db.getDatabase('issuanceIntent');
    const doc = {
      _id: txid,
      ...intent,
      updatedAt: Date.now()
    };
    await base.updateAsync({ _id: txid }, doc, { upsert: true });
    return doc;
  },

  async getIntent(txid) {
    const base = await db.getDatabase('issuanceIntent');
    return base.findOneAsync({ _id: txid });
  },

  async getIntentsByAddress(address) {
    const base = await db.getDatabase('issuanceIntent');
    return base.findAsync({ recipientAddress: address });
  }
};

module.exports = IssuanceIntent;

const litecoin = require('litecoin');
const config = {host: '127.0.0.1',
    port: 18332,
    user: 'user',
    pass: 'pass',
    timeout: 10000}

class ReOrgChecker {
  constructor(config) {
    this.client = new litecoin.Client(config);
  }

  async getBlock(hash) {
    try {
      return await this.client.getBlock(hash);
    } catch (error) {
      console.error('Error fetching block:', error);
      throw error;
    }
  }

  async checkReOrg() {
    try {
      const chainTips = await this.client.cmd('getchaintips');
      const potentialReorgs = chainTips.filter(tip => tip.status === 'valid-fork' || tip.status === 'headers-only');

      for (const tip of potentialReorgs) {
        const block = await this.getBlock(tip.hash);
        // Compare this block with your database
        // If this block is not in your main chain, a reorg might have occurred

        console.log(`Potential reorg detected at block ${block.height}: ${block.hash}`);
        // Implement additional logic to handle reorg if needed
      }
    } catch (error) {
      console.error('Error in checkReOrg:', error);
    }
  }
}

module.exports = ReOrgChecker;

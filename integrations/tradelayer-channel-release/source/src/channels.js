const dbInstance = require('./db.js');
const TallyMap = require('./tally.js')
const BigNumber = require('bignumber.js')
const TxUtils = require('./txUtils.js')
const { v4: uuidv4 } = require('uuid');

class Channels {
      // Initialize channelsRegistry as a static property
    static channelsRegistry = new Map();
    static pendingWithdrawals = []; // Array to store pending withdrawal objects
   
    
    static async addToRegistry(channelAddress, commiterA, commiterB) {
        // Add logic to register a new trade channel
        this.channelsRegistry.set(channelAddress, { commiterA, commiterB });
        await this.saveChannelsRegistry();
    }

    static async removeFromRegistry(channelAddress) {
        // Add logic to remove a trade channel
        this.channelsRegistry.delete(channelAddress);
        await this.saveChannelsRegistry();
    }

       // Function to set a channel object and save it in the registry
    static async setChannel(channelId, channelData) {
        // Set the channel object in the registry
        this.channelsRegistry.set(channelId, channelData);

        // Save the updated channels registry to the database
        await this.saveChannelsRegistry();
    }

    static async saveChannelsRegistry() {
        // Persist the channels registry to NeDB
        const channelsDB = await dbInstance.getDatabase('channels');
        const entries = [...this.channelsRegistry.entries()].map(([channelId, channelData]) => {
            return {
                _id: `${channelId}`, // Unique identifier for each channel
                data: channelData
            };
        });

        for (const entry of entries) {
            await channelsDB.updateAsync(
                { _id: entry._id },
                { $set: { data: entry.data } },
                { upsert: true }
            );
        }
    }

    // channels.js (core)

/**
 * Return all channel balances for a given commit address, optionally filtered by propertyId.
 * Reads from NeDB collection "channels" where docs look like:
 * { _id: <channelId>, data: { participants:{A,B}, channel, commits:[...], A:{pid:amt}, B:{pid:amt}, ... } }
 *
 * @param {object} deps
 * @param {string} address                 // commit/trading address to inspect
 * @param {number|undefined} propertyId    // optional property filter
 * @returns {Promise<Array<{channel:string, side:'A'|'B', propertyId:number, amount:number, lastCommitmentTime?:number}>>}
 */
static async getChannelBalancesForAddress(address, propertyId) {
  if (!address) throw new Error('address required');

  const channelsDB = await dbInstance.getDatabase('channels');
  const addr = address.trim();
  const addrLC = addr.toLowerCase();

  // Allow propertyId to be optional
  const pidFilter =
    propertyId === undefined || propertyId === null || propertyId === ''
      ? null
      : Number(propertyId);

  if (pidFilter !== null && Number.isNaN(pidFilter)) {
    throw new Error('propertyId must be a number');
  }

  // Find channels where we participate or have committed before
  const entries = await channelsDB.findAsync({
    $or: [
      { 'data.participants.A': addr },
      { 'data.participants.B': addr },
      { 'data.participants.A': addrLC },
      { 'data.participants.B': addrLC },
      { 'data.commits': { $elemMatch: { senderAddress: addr } } },
      { 'data.commits': { $elemMatch: { senderAddress: addrLC } } }
    ]
  });

  const rows = [];

  for (const doc of entries || []) {
    const data = doc.data || {};
    const chanId = data.channel || doc._id;

    // Determine our column (A/B)
    const aAddr = String(data?.participants?.A || '').toLowerCase();
    const bAddr = String(data?.participants?.B || '').toLowerCase();

    let side = null;
    if (aAddr && aAddr === addrLC) side = 'A';
    else if (bAddr && bAddr === addrLC) side = 'B';
    else {
      // Fallback: infer from our latest commit or lastUsedColumn
      const lastMine = [...(data.commits || [])]
        .reverse()
        .find(c => String(c.senderAddress || '').toLowerCase() === addrLC);
      if (lastMine?.columnAssigned === 'A' || lastMine?.columnAssigned === 'B') {
        side = lastMine.columnAssigned;
      } else if (data.lastUsedColumn === 'A' || data.lastUsedColumn === 'B') {
        side = data.lastUsedColumn;
      }
    }
    if (!side) continue;

    // Balances for our column (e.g. data.A = { "5": 0.1, ... })
    const sideBalances = data[side] || {};

    // Helper to push one row with enriched columns for UI
    const pushRow = (pid, amt) => {
      const nPid = Number(pid);
      const nAmt = Number(amt);
      if (!isFinite(nAmt) || nAmt <= 0) return;
      if (pidFilter !== null && nPid !== pidFilter) return;

      rows.push({
        channel: chanId,                               // channel id/address
        column: side,                                   // 'A' | 'B' (explicit UI label)
        side,                                           // keep original key for backwards compat
        propertyId: nPid,
        amount: nAmt,
        // Useful for UI actions (withdraw/transfer) without more queries:
        participants: {
          A: data?.participants?.A || '',
          B: data?.participants?.B || ''
        },
        counterparty: side === 'A'
          ? (data?.participants?.B || '')
          : (data?.participants?.A || ''),
        lastCommitmentBlock: data?.lastCommitmentTime ?? null,
        commitCount: Array.isArray(data?.commits) ? data.commits.length : 0,
        // did *we* ever mark payEnabled=true in a commit? (handy hint for UI)
        payEnabled: !!(Array.isArray(data?.commits) && data.commits.some(
          c => String(c.senderAddress || '').toLowerCase() === addrLC && c.payEnabled === true
        )),
        // If you store pubkeys/redeemScript/scriptPubKey, pass them along for immediate actions:
        channelPubkeys: data?.channelPubkeys || null,
        redeemScript: data?.redeemScript || null,
        scriptPubKey: data?.scriptPubKey || null
      });
    };

    if (pidFilter !== null) {
      pushRow(String(pidFilter), sideBalances[String(pidFilter)] || 0);
    } else {
      for (const [pid, val] of Object.entries(sideBalances)) {
        pushRow(pid, val);
      }
    }
  }

  // Largest first looks nice in a table
  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}


    /** Optional: aggregate sum across channels (for UI footers) */
    static sumBalance(rows) {
      return rows.reduce((acc, r) => acc + (r.amount || 0), 0);
    }

    /** Optional: group by channel -> { [channel]: { [propertyId]: amount } } */
    static toChannelPropMap(rows) {
      const m = {};
      for (const r of rows) {
        if (!m[r.channel]) m[r.channel] = {};
        m[r.channel][r.propertyId] = (m[r.channel][r.propertyId] || 0) + r.amount;
      }
      return m;
    }

    static async loadChannelsRegistry() {
        // Load the channels registry from NeDB
        const channelsDB = await dbInstance.getDatabase('channels');
        try {
            const entries = await channelsDB.findAsync({});
            //console.log('loading channel DB '+JSON.stringify(entries))
            this.channelsRegistry = new Map(entries.map(entry => [entry._id, entry.data]));
            //console.log(JSON.stringify(Array.from(this.channelsRegistry.entries())));
            return
        } catch (error) {
            if (error.message.includes('does not exist')) {
                // If the collection does not exist, initialize an empty registry
                this.channelsRegistry = new Map();
            } else {
                throw error;
            }
        }
    }

     // Function to save pending withdrawal object to the database
    static async savePendingWithdrawalToDB(withdrawalObj) {
        const withdrawalKey = `withdrawal-${withdrawalObj.blockHeight}-${withdrawalObj.senderAddress}`;
        const withdrawalDB = await dbInstance.getDatabase('withdrawQueue');
        await withdrawalDB.updateAsync(
            { _id: withdrawalKey },
            { $set: { data: withdrawalObj } },
            { upsert: true }
        );
    }

    // Function to load pending withdrawals from the database
    static async loadPendingWithdrawalsFromDB() {
        const withdrawalDB = await dbInstance.getDatabase('withdrawQueue');
        const entries = await withdrawalDB.findAsync({ _id: { $regex: /^withdrawal-/ } });
        return entries.map(entry => entry.data);
    }

    static async removePendingWithdrawalFromDB(withdrawalObj) {
        const withdrawalKey = `withdrawal-${withdrawalObj.blockHeight}-${withdrawalObj.senderAddress}`;
        const withdrawalDB = await dbInstance.getDatabase('withdrawQueue');
        
        // Remove the withdrawal from the database
        await withdrawalDB.removeAsync({ _id: withdrawalKey });
    }

     /**
     * Record a channel delta event in the `channelDelta` database.
     * @param {string} channelId - The channel id/address.
     * @param {string} column - 'A' or 'B'.
     * @param {number} propertyId - e.g. 1 for TL.
     * @param {number} amount - Signed amount (+credit, -debit).
     * @param {string} type - Type of event (e.g. 'debitInitMargin').
     * @param {string} participant - Address of the actor (optional).
     * @param {number} block - Block number.
     * @param {string} txid - Txid (optional).
     * @param {string} memo - Memo (optional).
     */
    static async recordChannelDelta({
        channelId,
        column,
        propertyId,
        amount,
        type,
        participant = '',
        block = 0,
        txid = '',
        memo = ''
    }) {
        const newUuid = uuidv4();
        const db = await dbInstance.getDatabase('channelDelta');
        const deltaKey = `${channelId}-${propertyId}-${column}-${block}-${newUuid}`;
        const delta = {
            channelId,
            column,
            propertyId,
            amount,
            type,
            participant,
            block,
            txid,
            memo,
            timestamp: Date.now()
        };
        console.log('[CHANNEL DELTA]', JSON.stringify(delta));

        try {
            await db.insertAsync({ _id: deltaKey, data: delta });
        } catch (error) {
            console.error('Error saving channelDelta:', error);
            throw error;
        }
    }

    // Record a token trade with specific key identifiers
    static async recordTokenTrade(trade, blockHeight, txid) {
        const tradeRecordKey = `token-${trade.offeredPropertyId}-${trade.desiredPropertyId}`;
        const tradeRecord = {
            key: tradeRecordKey,
            type: 'token',
            trade,
            blockHeight,
            txid
        };
        await this.saveTrade(tradeRecord);
    }

    // Record a contract trade with specific key identifiers
    static async recordContractTrade(trade, blockHeight, txid) {
        const tradeRecordKey = `contract-${trade.contractId}`;
        const tradeRecord = {
            key: tradeRecordKey,
            type: 'contract',
            trade,
            blockHeight,
            txid
        };
        await this.saveTrade(tradeRecord);
    }

    static async saveTrade(tradeRecord) {
        const tradeDB = await dbInstance.getDatabase('tradeHistory');

        // Use the key provided in the trade record for storage
        const tradeId = `${tradeRecord.key}-${tradeRecord.txid}-${tradeRecord.blockHeight}`;

        // Construct the document to be saved
        const tradeDoc = {
            _id: tradeId,
            ...tradeRecord
        };

        // Save or update the trade record in the database
        try {
            await tradeDB.updateAsync(
                { _id: tradeId },
                tradeDoc,
                { upsert: true }
            );
            console.log(`Trade record saved successfully: ${tradeId}`);
        } catch (error) {
            console.error(`Error saving trade record: ${tradeId}`, error);
            throw error; // Rethrow the error for handling upstream
        }
    }


    static async getChannel(channelId) {
        // Ensure the channels registry is loaded
        let channel = this.channelsRegistry.get(channelId)
        //console.log('inside getChannel '+channelId+' '+JSON.stringify(Array.from(this.channelsRegistry.entries())));
        console.log(Boolean(!channel),Boolean(channel==undefined),JSON.stringify(channel))
        if(!channel||channel==undefined||channel==null){
            await this.loadChannelsRegistry();
            channel = this.channelsRegistry.get(channelId)
            console.log('in getChannel 2nd hit '+JSON.stringify(channel));
            if(!channel){
              channel=null
            }
        }

        return channel
    }

    static async isValidChannel(channelAddress) {
        // Load the channel from the registry if not already loaded
        let channel = this.channelsRegistry.get(channelAddress);
        if (!channel) {
            await this.loadChannelsRegistry();
            channel = this.channelsRegistry.get(channelAddress);
        }

        // Check if the channel exists
        if (!channel) {
            console.log(`Channel ${channelAddress} does not exist`);
            return false;
        }
    }

    static async getCommitAddresses(channelAddress) {
        let channel = this.channelsRegistry.get(channelAddress);
        //console.log('inside getCommitAddresses '+JSON.stringify(channel)+' '+channelAddress)
        if(!channel||channel==undefined||channel==null){
          console.log('channel not found, loading from db')
          await Channels.loadChannelsRegistry()
          channel = this.channelsRegistry.get(channelAddress);
          //console.log('checking channel obj again '+JSON.stringify(channel))
        }
        if (channel && channel.participants) {
            const participants = channel.participants;
            //console.log('inside getCommitAddresses '+participants.A+ ' '+ participants.B)
            return {
                commitAddressA: participants.A,
                commitAddressB: participants.B
            };
        } else {
            return {commitAddressA: null,commitAddressB: null}; // Return null if the channel or participants data is not found
        }
    }

    static async addCommitment(channelId, commitment) {
        await this.db.updateAsync(
            { channelId: channelId },
            { $push: { commitments: commitment } },
            { upsert: true }
        );
    }

    static async getCommitments(channelId) {
        const channel = await this.db.findOneAsync({ channelId: channelId });
        return channel ? channel.commitments : [];
    }

    static compareCharacters(charA, charB) {
            if (charA === charB) {
                return 0; // Characters are equal
            } else {
                const isNumA = !isNaN(charA);
                const isNumB = !isNaN(charB);
                
                if (isNumA && !isNumB) {
                    return -1; // Numbers come first
                } else if (!isNumA && isNumB) {
                    return 1;
                } else {
                    return charA < charB ? -1 : 1; // Compare ASCII values
                }
            }
    }

    /**
     * Record a participant assignment or change in the channelDelta ledger.
     *
     * @param {string} channelId
     * @param {'A'|'B'} column
     * @param {string} newParticipant - The address now assigned to the column
     * @param {number} block - Block height of the change
     * @param {string} prevParticipant - (Optional) The old participant
     * @param {string} memo - (Optional) Additional info (e.g. 'assigned on commit')
     */
    static async recordParticipantChange(channelId, column, newParticipant, block, prevParticipant = '', memo = '') {
        await Channels.recordChannelDelta({
            channelId,
            column,
            propertyId: null, // Not a token move, so leave propertyId empty
            amount: 0,        // No amount (not a balance change)
            type: 'participantChange',
            participant: newParticipant,
            block,
            txid: '',
            memo: memo || `Set participant for ${column} to ${newParticipant}${prevParticipant ? ' (prev: ' + prevParticipant + ')' : ''}`
        });
    }


    /**
     * Debits initial margin from the channel's correct column (A or B) for a property.
     * Updates the registry and saves the channel state.
     * 
     * @param {string} channelId - The channel ID.
     * @param {string} participantAddr - The participant address (debtor).
     * @param {number} propertyId - The property to debit (e.g., 1 for TL).
     * @param {number|string|BigNumber} amount - Amount to debit (positive).
     * @param {number} block - Block number for logging/audit.
     * @param {string} [type='debitChannelContractTradeInitMargin'] - For logging/audit.
     */
    static async debitInitMarginFromChannel(channelId, participantAddr, propertyId, amount, block, type = 'debitChannelContractTradeInitMargin', txid){
        const BigNumber = require('bignumber.js');
        // 1. Load channel from memory or DB if needed
        let channel = await this.getChannel(channelId);
        if (!channel || !channel.participants) {
            throw new Error(`Channel ${channelId} not found or malformed`);
        }
        // 2. Decide column: 'A' or 'B'
        let column = null;
        if (channel.participants.A === participantAddr) {
            column = 'A';
        } else if (channel.participants.B === participantAddr) {
            column = 'B';
        } 
        // 3. Ensure balances exist (initialize to 0 if undefined)
        if (!channel[column]) channel[column] = {};
        if (typeof channel[column][propertyId] !== "number") channel[column][propertyId] = 0;
        // 4. Check balance
        let balBN = new BigNumber(channel[column][propertyId]);
        let amtBN = new BigNumber(amount);
        if (balBN.lt(amtBN)) {
            throw new Error(`Insufficient channel balance: ${balBN} < ${amtBN} in ${channelId} ${column} ${propertyId}`);
        }
        // 5. Debit the column (8 dp, no underflow)
        channel[column][propertyId] = balBN.minus(amtBN).decimalPlaces(8).toNumber();
        // 6. Save back to registry/DB
        await Channels.setChannel(channelId, channel);
        await Channels.recordChannelDelta({
            channelId,
            column,
            propertyId,
            amount: -amtBN.decimalPlaces(8).toNumber(), // Always negative for debits
            type,
            participant: participantAddr,
            block,
            txid,
            memo: '' // or whatever memo string you want
        });

        // 7. Optional: log to audit trail
        console.log(`[CHANNEL][${type}] Debited ${amtBN} from ${column}.${propertyId} of channel ${channelId} (addr: ${participantAddr}) at block ${block}`);

        return true;
    }

    static async assignColumnBasedOnAddress(channel, newCommitAddress, cpAddress,block){
        const column = Channels.assignColumnBasedOnLastCharacter(newCommitAddress);   
        // 1) If the channel isn't initialized yet, fall back to last-character rule
        if (!channel.participants?.A&&!channel?.participants.B) {
            channel.participants[column]=newCommitAddress
            await Channels.recordParticipantChange(
                channel.channel,      // channelId
                column,               // 'A' or 'B'
                newCommitAddress,     // new participant address
                block,                // current block
                '',                   // prevParticipant (none yet)
                'Initial assignment'
            );
            return channel
        }

        // 2) If this address already committed, preserve its column
        if (channel.participants.A === newCommitAddress||channel.participants.B === newCommitAddress){
            return channel
        } 

        // 3) the cp address is assigned and there's no conflict, includes crowded channel
        if (channel.participants[column] !== cpAddress && !channel.participants[column]) {
            const prev = channel.participants[column] || '';
            channel.participants[column] = newCommitAddress;
            await Channels.recordParticipantChange(
                channel.channel,
                column,
                newCommitAddress,
                block,
                prev,
                'Assigned via open slot (no conflict)'
            );
            return channel;
        }
        
        // 4. Crowded: default spot is already filled, so we need tie-break and bump
        if(channel.participants[column]==cpAddress||(channel.participants[column] && channel.participants[column] !== newCommitAddress)){
            const tiebreak = Channels.tieBreakerByBackChar(newCommitAddress, cpAddress, column);
           // winner must land on its computed winnerColumn; loser on the other
          const desiredA = (tiebreak.winnerColumn === 'A') ? tiebreak.winner : tiebreak.loser;
          const desiredB = (tiebreak.winnerColumn === 'B') ? tiebreak.winner : tiebreak.loser;
          // If for any reason we can't identify both, keep previous other side (never blank)
          const prevA = channel.participants.A || '';
          const prevB = channel.participants.B || '';
          const forceA = desiredA || prevA;
          const forceB = desiredB || ((prevA && prevA !== forceA) ? prevA : prevB);
          return Channels.bumpColumnAssignment(channel, forceA, forceB, block);
        }

        console.error(
            `[Channel Assign] Unexpected case in channel assignment for channel ${channel.channel}.\n` +
            `Participants: A=${channel.participants.A}, B=${channel.participants.B}\n` +
            `Incoming commit: ${newCommitAddress}\n` +
            `This should be handled earlier in the logic!`
        );
    }

    static resolveColumn(channel, addr) {
      const A = channel?.participants?.A ?? '';
      const B = channel?.participants?.B ?? '';
      if (!addr) return null;
      if (A === addr) return 'A';
      if (B === addr) return 'B';
      // single-counterparty fallback
      if (A && !B && A === addr) return 'A';
      if (B && !A && B === addr) return 'B';
      return null;
    }

    static assignColumnBasedOnLastCharacter(address, last = 1) {
      if (!address || typeof address !== 'string' || address.length === 0) {
        console.warn('[assignColumnBasedOnLastCharacter] invalid address, defaulting to A');
        return 'A'; // deterministic fallback
      }

      const idx = address.length - last;
      if (idx < 0) {
        console.warn('[assignColumnBasedOnLastCharacter] address too short, defaulting to A');
        return 'A';
      }

      const lastChar = address[idx];
      console.log('last char in assign column based on last character', lastChar);

      const oddCharacters = [
        'A','C','E','G','I','K','M','O','Q','S','U','W','Y',
        '1','3','5','7','9'
      ];

      const isOdd = oddCharacters.includes(lastChar.toUpperCase());
      return isOdd ? 'A' : 'B';
    }


  /**
 * Tie-breaker to assign addresses to columns based on their last N characters' parity.
 * Returns: { winner: address, loser: address, winnerColumn: 'A' | 'B', loserColumn: 'A' | 'B' }
 */
   static tieBreakerByBackChar(addr1, addr2, column, assignColFunc = Channels.assignColumnBasedOnLastCharacter) {
        const len = Math.min(addr1.length, addr2.length);
        for (let n = 1; n <= len; n++) {
            const col1 = assignColFunc(addr1, n);
            const col2 = assignColFunc(addr2, n);

            console.log(`[TieBreak] Char ${n}: ${addr1}[${col1}] vs ${addr2}[${col2}], competing for ${column}`);

            if (col1 === column && col2 !== column) {
                console.log(`[TieBreak WINNER] ${addr1} wins column ${column} at char -${n}`);
                return {
                    winner: addr1,
                    loser: addr2,
                    winnerColumn: column,
                    loserColumn: column === 'A' ? 'B' : 'A'
                };
            }
            if (col2 === column && col1 !== column) {
                console.log(`[TieBreak WINNER] ${addr2} wins column ${column} at char -${n}`);
                return {
                    winner: addr2,
                    loser: addr1,
                    winnerColumn: column,
                    loserColumn: column === 'A' ? 'B' : 'A'
                };
            }
        }
        // If no decisive winner, default addr1 to the requested column
        console.log(`[TieBreak DEFAULT] ${addr1} assigned ${column} by default (no unique winner)`);
        return {
            winner: addr1,
            loser: addr2,
            winnerColumn: column,
            loserColumn: column === 'A' ? 'B' : 'A'
        };
    }
    
      static predictColumnForAddress(channel, newCommitAddress, cpAddress) {

                // 0) Channel missing or malformed → fallback
              if (!channel || !channel.participants) {
                  return Channels.assignColumnBasedOnLastCharacter(newCommitAddress);
              }

              // 1) If channel is empty, fallback to last-character rule
              if (!channel.participants.A && !channel.participants.B) {
                  return Channels.assignColumnBasedOnLastCharacter(newCommitAddress);
              }
              // 2) If already present, preserve
              if (channel.participants.A === newCommitAddress) return 'A';
              if (channel.participants.B === newCommitAddress) return 'B';

              // 3) If the computed column is free (not cpAddress), assign
              const column = Channels.assignColumnBasedOnLastCharacter(newCommitAddress);
              if (channel.participants[column] !== cpAddress && !channel.participants[column]) {
                  return column;
              }

              // 4) Crowded, tie-break logic
              if (
                  channel.participants[column] === cpAddress ||
                  (channel.participants[column] && channel.participants[column] !== newCommitAddress)
              ) {
                  const tiebreak = Channels.tieBreakerByBackChar(newCommitAddress, cpAddress, column);
                  return tiebreak.winnerColumn;
              }

              // fallback: no assignment possible (shouldn't hit)
              return null;
          }

static async bumpColumnAssignment(channel, forceAis, forceBis, block = 0) {
  if (!channel) throw new Error('Channel object is required for bumpColumnAssignment');
  if (!channel.participants) channel.participants = { A: '', B: '' };
  channel.A = channel.A || {};
  channel.B = channel.B || {};

  const prevA = channel.participants.A;
  const prevB = channel.participants.B;

  // Normalize inputs so we never blank a side unintentionally
  const hasForceA = forceAis !== undefined && forceAis !== null && forceAis !== '';
  const hasForceB = forceBis !== undefined && forceBis !== null && forceBis !== '';
  let nextA = hasForceA ? forceAis : (prevA || '');
  let nextB = hasForceB ? forceBis : (prevB || '');

  // Avoid A/B collapsing to the same address when we can preserve distinctness
  if (nextA && nextA === nextB) {
    if (prevA && prevA !== nextA) nextB = prevA;
    else if (prevB && prevB !== nextA) nextB = prevB;
  }

  console.log(`[Bump] Current: A=${prevA}, B=${prevB} | Forcing(norm): A=${nextA}, B=${nextB}`);

  // 1) No change needed
  if (prevA === nextA && prevB === nextB) {
    console.log('[Bump] No swap needed.');
    return channel;
  }

  // 2) True swap: desired is exactly the other's current -> swap participants & balances
  if (prevA === nextB && prevB === nextA) {
    console.log(`[Bump] Swapping both participants and balances: A=${prevA}, B=${prevB}`);
    [channel.participants.A, channel.participants.B] = [channel.participants.B, channel.participants.A];
    [channel.A, channel.B] = [channel.B, channel.A];
  }
  // 3) One-sided match implies an A<->B swap too (keeps balances aligned with owners)
  else if (prevA === nextB || prevB === nextA) {
    console.log(`[Bump] Swapping participants & balances (one-sided match): A=${prevA}, B=${prevB}`);
    [channel.participants.A, channel.participants.B] = [channel.participants.B, channel.participants.A];
    [channel.A, channel.B] = [channel.B, channel.A];
    // After swap, if still not at target, set explicitly without touching balances again
    if (channel.participants.A !== nextA || channel.participants.B !== nextB) {
      console.log(`[Bump] Aligning participants post-swap to target: A=${nextA}, B=${nextB}`);
      channel.participants.A = nextA || channel.participants.A;
      channel.participants.B = nextB || channel.participants.B;
    }
  }
  // 4) Overwrite: assign both sides explicitly, keep balances on their current sides
  else {
    console.log(`[Bump] Overwriting participants: A=${nextA}, B=${nextB}`);
    channel.participants.A = nextA;
    channel.participants.B = nextB;
    // (Optionally) reset balances for a brand-new pairing:
    // channel.A = {};
    // channel.B = {};
  }

  // Emit participantChange deltas if changed
  if (channel.participants.A !== prevA) {
    await this.recordParticipantChange(
      channel.channel, 'A', channel.participants.A, block, prevA, 'Rotated (bumpColumnAssignment)'
    );
  }
  if (channel.participants.B !== prevB) {
    await this.recordParticipantChange(
      channel.channel, 'B', channel.participants.B, block, prevB, 'Rotated (bumpColumnAssignment)'
    );
  }

  console.log(`[Bump] Result: A=${channel.participants.A}, B=${channel.participants.B}`);
  return channel;
}


    // New function to process commitments and assign columns
    static async processChannelCommits(tradeChannelManager, channelAddress) {
        // Check if both parties have committed
        if (Channels.areBothPartiesCommitted(channelAddress)) {
            // Assign columns based on predefined logic
            const columnAssignments = Channels.assignColumns(channelAddress);
            Channels.updateChannelWithColumnAssignments(channelAddress, columnAssignments);
            //console.log(`Columns assigned for channel ${channelAddress}`);
        }
    }

    // This should be a static method of Channels, adjust class context as needed
    // Returns: { channel, valid, reason }
    static async handleChannelPubkey(channel, column, senderAddress, commitTxid) {
        let valid = true;
        let reason = '';

        //try {
            const tx = await TxUtils.getRawTransaction(commitTxid);
            const vin = tx.vin[0];  // Always use first input

            console.log('vin '+JSON.stringify(vin)+' '+commitTxid)
            const scriptType = TxUtils.getAddressTypeUniversal(senderAddress);
            console.log(scriptType)
            const pubkey = await TxUtils.extractPubkeyByType(vin, scriptType) || [];
            console.log('TxUtils pubkeys'+JSON.stringify(pubkey))
            if (pubkey==null) return new Error('No pubkey found in commit tx');

            // Store/overwrite pubkey for the column
            channel.channelPubkeys[column] = pubkey;

            // If both pubkeys are set, validate multisig address
            const pubA = channel.channelPubkeys.A;
            const pubB = channel.channelPubkeys.B;

            if (pubA && pubB) {
                const Vesting = require('./vesting.js')
                const instance = await Vesting.getInstance()
                const chain = instance.getChain();
                const isTestnet = instance.getTest();
                const multisig1 = await TxUtils.createMultisig(pubA, pubB, chain, isTestnet,senderAddress);
                const multisig2 = await TxUtils.createMultisig(pubB, pubA, chain, isTestnet,senderAddress);

                if (channel.channel !== multisig1 && channel.channel !== multisig2) {
                    valid = false;
                    reason = 'Multisig does not match channel address.';
                    return { channel, valid, reason };
                }
            }

            // All good
            return { channel, valid, reason };

        //} catch (err) {
        //    valid = false;
        //    reason = err.message;
        //    return { channel, valid, reason };
        //}
    }


    static async recordCommitToChannel(channelAddress, senderAddress, propertyId, tokenAmount, payEnabled, clearLists, blockHeight, txid, commitClearlistId = null){
        console.log('inside record Commit '+channelAddress+' '+senderAddress+' '+propertyId+' '+tokenAmount+' '+blockHeight+ txid)
          if (!this.channelsRegistry) {
             await this.loadChannelsRegistry();
          }
        // Check if the channel exists in the registry
        if (!this.channelsRegistry.has(channelAddress)) {
            // Initialize a new channel record if it doesn't exist
            this.channelsRegistry.set(channelAddress, {
                participants: {'A':'','B':''},
                channel: channelAddress,
                commits: [],
                A: {},
                B: {},
                clearLists: { A: [], B: [] },
                payEnabled: { A: false, B: false },
                lastCommitmentTime: blockHeight,
                lastUsedColumn: null, // Initialize lastUsedColumn to null
                channelPubkeys: {A:'',B:''}
            });
        }

        // Get the channel from the registry
        let channel = this.channelsRegistry.get(channelAddress);
        console.log(JSON.stringify(channel))
        // Determine the column for the sender address
        let cpAddress = ''
        if(channel.participants.A!==senderAddress&&channel.participants.A){
            cpAddress = channel.participants.A
        }else if(channel.participants.B!==senderAddress&&channel.participants.B){
            cpAddress = channel.participants.B
        }
        let channelColumn = Channels.predictColumnForAddress(channel, senderAddress, cpAddress)
        console.log('column prediction '+channelColumn)
        console.log('about to handle pubkeys '+JSON.stringify(channel)+' '+senderAddress+' '+cpAddress)
        const { channel: updatedChannel, valid, reason } = await Channels.handleChannelPubkey(channel, channelColumn, senderAddress, txid);
        if (!valid) {
            console.log('DISPLACED COMMIT USURPER')
            return
        }
        channel = updatedChannel
        console.log('channel after handle pubkeys '+JSON.stringify(channel))
        channel = await Channels.assignColumnBasedOnAddress(channel, senderAddress, cpAddress,blockHeight);
        const participants = channel.participants;
        channelColumn = Channels.resolveColumn(channel, senderAddress);
        console.log('resolved columen '+channelColumn)
        // Guard: if we failed to resolve a column, bail safely
         if (channelColumn == null) {
            console.log('ERR WITH COMMIT '+senderAddress+' '+channelAddress+' '+blockHeight+' (channelColumn==null)');
            return;
          }  console.log('assinging column in recordCommit' +channelColumn)
        // Update the balance in the specified column
        if (!channel[channelColumn][propertyId]) {
            channel[channelColumn][propertyId] = 0;
        }
        
    const existingBalance = new BigNumber(channel[channelColumn][propertyId] || 0);

    // Add the tokenAmount with 8-decimal precision
    channel[channelColumn][propertyId] = existingBalance
        .plus(new BigNumber(tokenAmount))
        .decimalPlaces(8) // Ensure precision is limited to 8 decimals
        .toNumber();
        console.log('modifying column balance '+tokenAmount+' '+channel[channelColumn][propertyId])
        // Add the commit record to the channel
        const commitRecord = {
            senderAddress,
            propertyId,
            tokenAmount,
            block: blockHeight,
            columnAssigned: channelColumn,
            payEnabled: payEnabled,
            commitClearlistId
        };

        await Channels.recordChannelDelta({
            channelId: channel.channel,
            column: channelColumn,
            propertyId,
            amount: new BigNumber(tokenAmount).decimalPlaces(8).toNumber(), // Always positive for commit
            type: 'creditCommit',
            participant: senderAddress,
            block: blockHeight,
            txid,
            memo: 'Commit'
        });


        // Always store clearLists on commit (controls counterparty restrictions)
        if (!channel.clearLists) channel.clearLists = { A: [], B: [] };
        if (!channel.payEnabled) channel.payEnabled = { A: false, B: false };
        if (Array.isArray(clearLists) && clearLists.length > 0) {
            channel.clearLists[channelColumn] = clearLists;
        }
        if (payEnabled) {
            channel.payEnabled[channelColumn] = true;
        }
        channel.participants[channelColumn]=senderAddress;
        channel.commits.push(commitRecord);

        // Update the last commitment time and used column
        channel.lastCommitmentTime = blockHeight;
        channel.lastUsedColumn = channelColumn;
        console.log(JSON.stringify(channel))
        // Save the updated channel information
        this.channelsRegistry.set(channelAddress,channel)
        await this.saveChannelsRegistry();
        return channel
        console.log(`Committed ${tokenAmount} of propertyId ${propertyId} to ${channelColumn} in channel for ${senderAddress}`);
    }

    static areBothPartiesCommitted(channelAddress) {
          const channel = this.channelsRegistry.get(channelAddress);
          if (!channel) return false; // Channel does not exist
          return channel.participants.size === 2; // True if two unique participants have committed
     }

      // Function to add a pending withdrawal object to the array
    static async addToWithdrawalQueue(blockHeight, senderAddress, amount, channelAddress,propertyId, withdrawAll, column) {
        if(column==false){
          column ="A"
        }else if(column == true){
          column ="B"
        }

        const withdrawalObj = {
            withdrawAll: withdrawAll,
            blockHeight: blockHeight,
            senderAddress: senderAddress,
            amount: amount,
            channel: channelAddress,
            propertyId: propertyId,
            column: column
        };
        this.pendingWithdrawals.push(withdrawalObj);
        await this.savePendingWithdrawalToDB(withdrawalObj);
    }

    // Function to process withdrawals
    static async processWithdrawals(blockHeight) {
        if (this.pendingWithdrawals.length === 0) {
            // Load pending withdrawals from the database if the array is empty
            const pendingWithdrawalsFromDB = await this.loadPendingWithdrawalsFromDB();
            if(pendingWithdrawalsFromDB.length!=0){
               //console.log('inside process withdrawals '+JSON.stringify(Array.from(pendingWithdrawalsFromDB.entries())));
                }
            if (pendingWithdrawalsFromDB.length === 0) {
                return; // No pending withdrawals to process
            } else {
                // Merge loaded pending withdrawals with existing array
                this.pendingWithdrawals.push(...pendingWithdrawalsFromDB);
            }
        }
        //console.log('about to process withdrawals '+blockHeight)
        // Process pending withdrawals
        for (let i = 0; i < this.pendingWithdrawals.length; i++) {
            const withdrawal = this.pendingWithdrawals[i];
            console.log('inside process withdrawals '+JSON.stringify(withdrawal))
            const { block, senderAddress, amount, channel, propertyId, withdrawAll, column } = withdrawal;
            //console.log('about to call getChannel in withdrawals '+channel+' ' +JSON.stringify(withdrawal))
            let thisChannel = await this.getChannel(channel)
            if(thisChannel==undefined){
              //console.log('channel has been removed for 0 balances '+channel)
                this.pendingWithdrawals.splice(i, 1);
                i--;
                await this.removePendingWithdrawalFromDB(withdrawal)
            }
            //console.log('checking thisChannel in withdraw '+JSON.stringify(thisChannel))
            // Function to get current block height

            // Check if it's time to process this withdrawal
            //console.log('seeing if block is advanced enough to clear waiting period '+withdrawal.blockHeight,blockHeight)
            if (blockHeight >= withdrawal.blockHeight + 7) {
                // Check if sender has sufficient balance for withdrawal
                
                //console.log('inside processing block '+JSON.stringify(thisChannel)+' '+channel)
                let column
                if(thisChannel.participants.A==senderAddress){
                  column = "A"
                }else if(thisChannel.participants.B==senderAddress){
                  column = "B"
                }else{
                  //console.log('sender not found on channel '+senderAddress + ' '+channel)
                  continue
                }
                    if(withdrawAll==true){
                        await this.processWithdrawAll(senderAddress,thisChannel,column,blockHeight)
                    }
                let balance
                if(column=="A"){
                  balance = thisChannel.A[propertyId]
                }else if(column=="B"){
                  balance = thisChannel.B[propertyId]
                }
                if (balance >= amount&&!isNaN(amount)) {
                    if(!withdrawAll){
                        await this.processWithdrawal(senderAddress,thisChannel,amount,propertyId,column,blockHeight)
                    }
                  
                    // Remove processed withdrawal from the array
                    this.pendingWithdrawals.splice(i, 1);
                    i--; // Adjust index after removal
                    await this.removePendingWithdrawalFromDB(withdrawal)
                } else {
                    // Insufficient balance, eject the withdrawal from the queue
                    console.log(`Insufficient balance for withdrawal: ${senderAddress}`+' amt'+amount+' prptyid'+propertyId);
                    this.pendingWithdrawals.splice(i, 1);
                    i--; // Adjust index after removal
                    await this.removePendingWithdrawalFromDB(withdrawal)
                }
            }       
        }
        await this.saveChannelsRegistry()
        return 
    }

    static async removeEmptyChannels() {
        for (const [channelAddress, channelData] of this.channelsRegistry.entries()) {
            
            const empty = await this.isChannelEmpty(channelData);
            //console.log('inside remove Empty Channels '+channelAddress+' '+empty+' ' +JSON.stringify(channelData))
            if (empty) {
                this.channelsRegistry.delete(channelAddress);
                //console.log(`Removed empty channel: ${channelAddress}`);
                await this.removeChannelFromDB()
            }
        }
    }

    static async isChannelEmpty(thisChannel) {
        if (!thisChannel || !thisChannel.participants) {
            return true; // Assuming channel is empty if it doesn't exist or has no participants
        }

        const participantA = thisChannel.A || {};
        const participantB = thisChannel.B || {};
        //console.log('inside isChannelEmpty '+JSON.stringify(participantA)+' '+ JSON.stringify(participantB))
      
        // Check if all properties in A and B are 0
        for (const propertyId in participantA) {
          //console.log(participantA[propertyId], Boolean(participantA[propertyId]!==0), Boolean(participantA[propertyId]==0))
            if (participantA[propertyId] !== 0) {
                return false; // Not empty if any property in participantA is not 0
            }
        }
        for (const propertyId in participantB) {
              //console.log(participantA[propertyId],Boolean(participantB[propertyId]!==0), Boolean(participantB[propertyId]==0))
            if (participantB[propertyId] !== 0) {
                return false; // Not empty if any property in participantB is not 0
            }
        }
        return true; // Empty if all properties in A and B are 0
    }

    static async removeChannelFromDB(channelAddress) {
      const channelsDB = await dbInstance.getDatabase('channels');
      const withdrawalKey = `${channelAddress}`;
      
      // Remove the channel entry from the database
      await channelsDB.removeAsync({ _id: withdrawalKey });
  }



    static adjustChannelBalances(channelAddress, propertyId, amount, column) {
          // Logic to adjust the token balances within a channel
          // This could involve debiting or crediting the committed columns based on the PNL amount
          const channel = this.channelsRegistry.get(channelAddress);
          channel[column][propertyId]+=amount
          if (!channel) {
              throw new Error('Trade channel not found');
          }
           this.channelsRegistry.set(channelAddress, channel)
          // Example logic to adjust balances
          // Update the channel's token balances as needed
    }

    // Transaction processing functions
    static async processWithdrawal(senderAddress,channel,amount,propertyId,column,block) {
      // Update balances and logic for withdrawal
      // Example logic, replace with actual business logic
      //console.log('checking channel obj in processWithdrawal '+JSON.stringify(channel))
      //console.log('in processWithdrawal '+channel[column][propertyId])
      const TallyLazy = require('./tally.js')
      let has = await TallyLazy.hasSufficientReserve(channel.channel,propertyId,amount)
      console.log(amount, has.hasSufficient)
      if(has.hasSufficient==false){
         amount-=has.shortfall
      }
      console.log(amount, has.shortfall)
      channel[column][propertyId] -= amount;
      console.log('about to modify tallyMap in processWithdrawal '+channel.channel,propertyId,amount,senderAddress)
      await TallyLazy.updateChannelBalance(channel.channel, propertyId, -amount, 'channelWithdrawalPull',block)
      await TallyLazy.updateBalance(senderAddress,propertyId, amount, 0, 0,0,'channelWithdrawalComplete',block)
      this.channelsRegistry.set(channel.channel, channel);
      return
    }

    static async processWithdrawAll(senderAddress, thisChannel, column,blockHeight) {
        for (const [propertyId, amount] of Object.entries(thisChannel[column])) {
          console.log('in process withdraw all '+senderAddress,thisChannel, amount, propertyId, column)
            await this.processWithdrawal(senderAddress, thisChannel, amount, parseInt(propertyId), column,blockHeight);
        }
    }


    static async processTransfer(transaction) {
      const clearlistManager = require('./clearlist.js');
      // Process a transfer within a trade channel
      const { fromChannel, toChannel, amount, propertyId, transferorIsColumnA, destinationColumn } = transaction;
      const sourceChannel = this.channelsRegistry.get(fromChannel);
      const destinationChannel = this.channelsRegistry.get(toChannel);

      if (!sourceChannel || !destinationChannel) {
        throw new Error('Channel(s) not found');
      }

      // Enforce channel clearLists: at least one side must be attested in any declared clearlist
      const sourceColumn = transferorIsColumnA ? 'A' : 'B';
      const sourceAddr = sourceChannel.participants?.[sourceColumn];
      const destAddr = destinationChannel.participants?.[destinationColumn];
      const allLists = [
          ...(sourceChannel.clearLists?.A || []),
          ...(sourceChannel.clearLists?.B || []),
          ...(destinationChannel.clearLists?.A || []),
          ...(destinationChannel.clearLists?.B || [])
      ];

      if (allLists.length > 0) {
          let sourceApproved = false;
          let destApproved = false;

          for (const listId of allLists) {
              if (!sourceApproved && sourceAddr && await clearlistManager.isAddressInClearlistOrDerived(listId, sourceAddr)) {
                  sourceApproved = true;
              }
              if (!destApproved && destAddr && await clearlistManager.isAddressInClearlistOrDerived(listId, destAddr)) {
                  destApproved = true;
              }
              if (sourceApproved || destApproved) break;
          }

          if (!sourceApproved && !destApproved) {
              throw new Error(`Neither transferor (${sourceAddr}) nor destination (${destAddr}) is attested in channel clearLists [${allLists}]`);
          }
      }

      // Update balances and logic for transfer
      // Example logic, replace with actual business logic
      if(transferorIsColumnA&&destinationColumn=='A'){
          sourceChannel.A[propertyId] -= amount;
          destinationChannel.A[propertyId] += amount;
      }else if(transferorIsColumnA&&destinationColumn=='B'){
          sourceChannel.A[propertyId] -= amount;
          destinationChannel.B[propertyId] += amount;
      }else if(!transferorIsColumnA&&destinationColumn=='A'){
          sourceChannel.B[propertyId] -= amount
          destinationChannel.A +=amount
      }else if(!transferorIsColumnA&&destinationColumn=='B'){
          sourceChannel.A[propertyId] -= amount
          destinationChannel.B +=amount
      }
     
      this.channelsRegistry.set(fromChannel, sourceChannel);
      this.channelsRegistry.set(toChannel, destinationChannel);
    }

    static updateChannelWithColumnAssignments(channelAddress, columnAssignments) {
        const channel = this.channels.get(channelAddress);
        if (!channel) return; // Exit if channel does not exist

        channel.commits = columnAssignments.map(commit => ({
            ...commit,
            columnAssigned: true
        }));
    }
}

module.exports = Channels;

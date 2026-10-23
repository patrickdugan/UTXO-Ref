const InsuranceFund = require('./insurance.js');
const PropertyManager = require('./property.js'); // Assuming Property has the createToken method
const ClearList = require('./clearlist.js')
const ContractList = require('./contractRegistry.js')
const BigNumber = require('bignumber.js')
const ClientWrapper = require('./client.js')
//const math = require('mathjs');

class TradeLayerManager {
    static instance = null;
   
    constructor(adminAddress, chain, test) {
        if (!TradeLayerManager.instance) {
            this.adminAddress = adminAddress;
            this.chain = chain; // Temporarily set
            this.test = test
            TradeLayerManager.instance = this;
        }
    }

    getChain(){
        return this.chain
    }

    getTest(){
        return this.test
    }

    async ensureChainInitialized() {
        console.log("Checking for valid chain..."+this.chain+' '+this.test);

        // Skip initialization if chain and test are already set

        if (this.chain && this.test !== undefined) {
            console.log(`Chain already initialized: ${this.chain}, Test: ${this.test}`);
            this.setChainParams(this.chain);
            return;
        }

        const client = await ClientWrapper.getInstance();
        let attempts = 0;
        const maxAttempts = 10; // Maximum retries
        const delay = 2000; // Delay between retries (ms)

        while (attempts < maxAttempts) {
            try {
                const chainInfo = await client.getChain();
                const testInfo = await client.getTest();
                console.log('chain and test '+chainInfo+' '+testInfo)
                if (chainInfo && testInfo!==undefined) {
                    this.chain = chainInfo;
                    this.test = testInfo;
                    console.log(`Chain initialized: ${this.chain}`);
                    this.setChainParams(this.chain);
                    return;
                }
            } catch (error) {
                console.error(`Error fetching chain status (attempt ${attempts + 1}):`, error);
            }

            attempts++;
            console.log(`Retrying chain initialization... (${attempts}/${maxAttempts})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Fallback in case of failure
        console.error("Failed to initialize chain. Using default chain.");
        this.chain = "BTC"; // Default to BTC if initialization fails
        this.setChainParams(this.chain);
    }

    setChainParams(chain) {
        // Access the chain via the client or environment variable
       
        
        // Configure parameters based on the chain
        if (this.chain === 'BTC') {
            this.baseVolume = 100;
            this.minRebate = 0.00000625;
            this.maxRebate = 0.0001;
            this.initialTokenAmount = 100000;
            this.tickerSymbol = 'TL';
            this.hedgeLeverage = 5;
            this.expiryInterval = 12960
            this.sponsorAddress = "bc1qhc2cj60auf67e0pa3dfd46cvg0fehchx56vw0f"
            this.freePortion = 0.1
            this.insurancePortion = 0.1
            this.vestingPortion = 0.5
            this.salePortion = 0
            if (require('./deploymentProfile').readDeploymentProfile()) {
                // Fresh testnet4 allocation: the previously unallocated 30%
                // is split equally between insurance and the existing sponsor.
                this.freePortion = 0.25;
                this.insurancePortion = 0.25;
                const bitcoin = require('bitcoinjs-lib');
                this.sponsorAddress = bitcoin.address.fromOutputScript(
                    bitcoin.address.toOutputScript(this.sponsorAddress, bitcoin.networks.bitcoin), bitcoin.networks.testnet);
            }
        } else if (this.chain === 'DOGE') {
            this.baseVolume = 2000000;
            this.minRebate = 0.00000125;
            this.maxRebate = 0.0005;
            this.initialTokenAmount = 200000000;
            this.tickerSymbol = 'TD';
            this.hedgeLeverage = 10;
            this.expiryInterval = 129600
            this.sponsorAddress = "D8HA73pAhxK7eNXSUVhQrWpUkrszUDGs7Z"
            this.freePortion = 0.25
            this.insurancePortion = 0.25
            this.vestingPortion = 0.5
            this.salePortion = 0
        } else { // Default to Litecoin (LTC)
            this.baseVolume = 1000;
            this.minRebate = 0.000003125;
            this.maxRebate = 0.0001;
            this.initialTokenAmount = 500000;
            this.tickerSymbol = 'TLITE';
            this.hedgeLeverage = 5;
            this.expiryInterval= 51840
            this.sponsorAddress = "MWip91xMhaEmDn5oUW5NDNbWSDyG5dSK9Q"
            this.freePortion = 0.1
            this.salePortion = 0.1
            this.insurancePortion = 0.3
            this.vestingPortion = 0.5
        }
    }

    static async getInstance(adminAddress, chain, test){
        if (!TradeLayerManager.instance) {
            TradeLayerManager.instance = new TradeLayerManager(adminAddress,chain,test);
            await TradeLayerManager.instance.ensureChainInitialized();
            console.log('generating new TL manager')
        }
        console.log('returning TL Manager')
        return TradeLayerManager.instance;
    }

    async initializeTokens(block) {
        const TallyMap = require('./tally.js');
         const alreadyInitialized = await TallyMap.checkInitializationFlag();
        console.log('initalizaing with admin '+this.adminAddress+' '+this.chain+' '+this.test)
        if(this.adminAddress==undefined||this.adminAddress==null){
            console.log('lag with admin assignment')

            if (this.chain === 'BTC') {
                this.adminAddress = this.test ? 'tb1q8f84erfegxhaylmvpfll9m5rgwymqy4akjnnvq' : 'bc1qktknrnx2jcchjht9anz0uy8ae02xryxq2vxeem,';
            } else if (this.chain === 'DOGE') {
                this.adminAddress = this.test ? 'nop27JQWbGr95ySHXZMzCg8XXxYzbCBZAW' : 'DLSfu9qvEggkeXAgCAwBBw5BVLvMCtkewz';
            } else if (this.chain === 'LTC') {
                this.adminAddress = this.test ? 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8' : 'MTmoypkhRQoJ172ZqxcsVumPZfJ8KCrQCB';
            }
        }
         
        if (!alreadyInitialized) {
            var TLTokenId = 1;
            const TLTotalAmount = this.initialTokenAmount;
            const ticker = this.tickerSymbol;
            const vestTicker = ticker+"VEST"
            const incomeTicker = ticker+"I"
            const incomeVestTicker = incomeTicker + "VEST"
            var TLVESTTokenId = 2;
            const TLVESTTotalAmount = new BigNumber(TLTotalAmount).times(this.vestingPortion).toNumber();
            var amountToInsuranceFund = new BigNumber(TLTotalAmount).times(this.insurancePortion).toNumber();
            const TLInitialLiquidity = new BigNumber(TLTotalAmount).times(this.salePortion).toNumber();
            const freeTranche = new BigNumber(TLTotalAmount).times(this.freePortion).toNumber();
            const TLIVESTinitialLiquidity = new BigNumber(TLTotalAmount).times(3).toNumber()
            const TLITotalAmount = TLIVESTinitialLiquidity+1
            const propertyManager = PropertyManager.getInstance()
            TLTokenId = await propertyManager.createToken(ticker, TLTotalAmount, 'Fixed', 0);
            TLVESTTokenId = await propertyManager.createToken(vestTicker, TLVESTTotalAmount, 'Vesting',0);
            const TLIVESTToken = await propertyManager.createToken(incomeTicker, TLIVESTinitialLiquidity, 'Vesting', 0)
            const TLI = await propertyManager.createToken(incomeVestTicker, TLITotalAmount, 'Native',0)

            const NativeHedgeId = await TradeLayerManager.initializeContractSeries(block)

            console.log('verifying that propertyid numbering is consistent with native contract id '+TLTokenId,TLVESTTokenId,NativeHedgeId)
            const insuranceFund = await InsuranceFund.getInstance(1, false);
            // Distribute initial amount to insurance fund
            await insuranceFund.deposit(TLTokenId, amountToInsuranceFund, block);
            
            await TallyMap.updateBalance(this.adminAddress, TLTokenId, TLInitialLiquidity, 0, 0, 0);
            await TallyMap.updateBalance(this.adminAddress, TLVESTTokenId, TLVESTTotalAmount, 0, 0, TLVESTTotalAmount);
            await TallyMap.updateBalance(this.adminAddress, TLIVESTToken, TLIVESTinitialLiquidity, 0,0, TLIVESTinitialLiquidity)
            await TallyMap.updateBalance(this.adminAddress, TLI, 1,0,0,0)
            await TallyMap.updateBalance(this.sponsorAddress, TLTokenId, freeTranche,0,0,0)

            const balances = await TallyMap.getAddressBalances(this.adminAddress)

            await TradeLayerManager.initializeClearlists();

            // After initializing tokens, set the flag
            await TallyMap.setInitializationFlag();
            return balances
        }
    }

    static async initializeContractSeries(block) {
        const params = {
            // Define contract properties such as margin requirements, expiry, etc.
            // Example properties:
            initialMargin: 0.2, // 20%
            maintenanceMargin: 0.1, // 10%
            expiry: 'perp', //need to assure that perp or 0 or null etc. codes to perpetual
            onChainData: [[1, 0]], //LTC vs. TL, need to assure that the propertyid for TL init's to 1 and that 0 corresponds to LTC UTXO
            expiryInterval: this.expiryInterval,
            leverage: this.hedgeLeverage||5,
            seriesLength: 6,
            native:true,
            inverse: true,
            fee: false,
            notionalPropertyId: 0,
            notionalValue: 0.001,
            collateralPropertyId: 1
        };

        // Create the contract series
        return await ContractList.createContractSeries(this.adminAddress, params, block);

        // Additional setup if required, such as initializing order books, setting initial market conditions, etc.
    }

     static async initializeClearlists() {

        // Initialize issuer whitelist
        const issuerClearlistId = ClearList.createClearlist(
            this.adminAddress,
            'Issuer Clearlist',
            '',
            'Oracles and Tokens included in Liquidity Reward',
            this.sponsorAddress,
            1
        );

        // Initialize market maker whitelist
        const marketMakerClearlistId = ClearList.createClearlist(
            this.adminAddress,
            'Market Maker Clearlist',
            '',
            'Market Makers and active traders who do not wash trade.',
            this.sponsorAddress,
            2
        );

          const accreditedListId = ClearList.createClearlist(
            this.adminAddress,
            'Accredited Clearlist',
            '',
            'Exempt from restrictions on native tokens.',
            this.sponsorAddress,
            3
        );

        console.log(`Issuer clearlist created with ID: ${issuerClearlistId}`);
        console.log(`Market maker clearlist created with ID: ${marketMakerClearlistId}`);
        console.log(`Acc. clearlist created with ID: ${accreditedListId}`)

        return
    }

static async updateVesting(cumulativeVolumeLTC, currentBlockVolumeLTC, cumulativeVolumeGlobal, currentBlockVolumeGlobal) {
    const propertyData1 = await PropertyManager.getPropertyData(2);
    const propertyData2 = await PropertyManager.getPropertyData(3);

    if (!propertyData1 || !propertyData2) {
        return null;
    }

    let maxTokens2 = propertyData1.totalInCirculation;
    let maxTokens3 = propertyData2.totalInCirculation;

    // Constants for vesting ranges
    const min1 = 1000;
    const max1 = 1000000000; // 1B
    const min2 = 10000000000; // 10B
    const max2 = 1000000000000; // 1T

    console.log(`Inside update vesting: ${cumulativeVolumeLTC}, ${currentBlockVolumeLTC}, ${cumulativeVolumeGlobal}, ${currentBlockVolumeGlobal}, ${maxTokens2}, ${maxTokens3}`);

    // Calculate cumulative volumes
    const newCumulativeVolumeLTC = cumulativeVolumeLTC + currentBlockVolumeLTC;
    const newCumulativeVolumeGlobal = cumulativeVolumeGlobal + currentBlockVolumeGlobal;

    // First Tranche Vesting (LTC Volume)
    let vestingPercentage1 = 0;
    if (newCumulativeVolumeLTC >= min1) {
        vestingPercentage1 = Math.min(
            (newCumulativeVolumeLTC - min1) / (max1 - min1),
            1
        );
    }
    const vestingAmount1 = vestingPercentage1 * maxTokens2;

    // Second Tranche Vesting (Global Volume)
    let vestingPercentage2 = 0;
    if (newCumulativeVolumeGlobal >= min2) {
        vestingPercentage2 = Math.min(
            (newCumulativeVolumeGlobal - min2) / (max2 - min2),
            1
        );
    }
    const vestingAmount2 = vestingPercentage2 * maxTokens3;

    console.log(`Ending vesting calc: ${vestingAmount1}, ${vestingAmount2}`);
    return { two: vestingAmount1, three: vestingAmount2 };
}

     static calculateTradeRebates(cumulativeVolume) {
        const { baseVolume, minRebate, maxRebate } = TradeLayerManager.instance;
        if (cumulativeVolume < baseVolume) {
            return maxRebate;
        }
        const scale = Math.log(cumulativeVolume / baseVolume) / Math.log(100000000 / baseVolume);
        const rebate = maxRebate - scale * (maxRebate - minRebate);
        return Math.max(rebate, minRebate);
    }

    static performBuyback(feeCaches) {
        feeCaches.forEach(cache => {
            const orderbook = this.fetchOrderbookForToken(cache.tokenId);
            const buybackAmount = this.calculateBuybackAmount(cache, orderbook);
            // Execute buyback transaction
        });
    }

    static fetchOrderbookForToken(tokenId) {
        // Fetch the orderbook for the given token
        // Implementation depends on your system's data sources
    }

    static calculateBuybackAmount(cache, orderbook) {
        let availableFunds = cache.funds;
        let totalBuybackAmount = 0;

        for (const order of orderbook) {
            const orderCost = order.price * order.amount;
            if (availableFunds >= orderCost) {
                totalBuybackAmount += order.amount;
                availableFunds -= orderCost;
            } else {
                const partialAmount = availableFunds / order.price;
                totalBuybackAmount += partialAmount;
                availableFunds = 0;
                break;
            }

            if (availableFunds <= 0) break;
        }

        return totalBuybackAmount;
    }

/** ------------------------------
 * TLVEST per-trade award model — static class methods
 * Paste INSIDE your class body (e.g., class TradeLayerManager { ... })
 * ------------------------------ */

static get EPS() { return 1e-18; }

/** Vesting fraction on a log curve from V0 → V* (in BTC printed volume) */
static vestFraction(cumV, V0, Vstar, alpha) {
  if (cumV <= V0) return 0;
  const num = Math.log(1 + (cumV - V0) / Math.max(alpha, this.EPS));
  const den = Math.log(1 + (Vstar - V0) / Math.max(alpha, this.EPS));
  const v = num / Math.max(den, this.EPS);
  return Math.max(0, Math.min(1, v));
}

/** Geometric projection: sum of next 12 months given current monthly vol and CMGR */
static projectNextYearVolumeBTC(monthlyBTC, cmgr) {
  if (cmgr <= this.EPS) return 12 * monthlyBTC;
  const r = 1 + cmgr;
  return monthlyBTC * ((Math.pow(r, 12) - 1) / cmgr);
}

/** Months needed to reach V* from cumV with monthlyBTC growing at cmgr */
static monthsToReach(cumV, Vstar, monthlyBTC, cmgr) {
  const remaining = Math.max(0, Vstar - cumV);
  if (remaining <= this.EPS) return 0;
  if (monthlyBTC <= this.EPS) return Infinity;
  if (cmgr <= this.EPS) return Math.ceil(remaining / monthlyBTC);
  const r = 1 + cmgr;
  // monthlyBTC * (r^n - 1) / (r - 1) >= remaining
  const numerator = (remaining * (r - 1)) / monthlyBTC + 1;
  if (numerator <= 1) return 0;
  const n = Math.log(numerator) / Math.log(r);
  return Math.ceil(n);
}

/** Annualize 12-mo CMGR to an annual growth rate */
static annualizeFromCMGR(cmgr) {
  return Math.pow(1 + cmgr, 12) - 1;
}

/** Discount factor for t months at annual rate r (continuous comp) */
static discountFactorMonths(rAnnual, months) {
  const tYears = months / 12;
  return Math.exp(-rAnnual * tYears);
}

/** Optional: compute CMGR from a monthly series (array of numbers) */
static cmgrFromSeries(monthlySeries) {
  if (!Array.isArray(monthlySeries) || monthlySeries.length < 2) return 0;
  let sumLog = 0, pairs = 0;
  for (let i = 1; i < monthlySeries.length; i++) {
    const prev = Math.max(monthlySeries[i - 1], this.EPS);
    const cur  = Math.max(monthlySeries[i], this.EPS);
    sumLog += Math.log(cur / prev);
    pairs++;
  }
  return Math.exp(sumLog / Math.max(pairs, 1)) - 1; // monthly CMGR
}

/**
 * Main: compute TLVEST tokens to award for a single trade.
 * trade: { notionalBtc: number, vip?: boolean }
 * params:
 *  - feeRate (e.g., 0.000005 for 0.5 bps)
 *  - baseRebateShare (e.g., 0.40)
 *  - vipRebateShare (e.g., 0.20) if trade.vip = true
 *  - dividendShareOfFees (e.g., 0.50)
 *  - discountRateAnnual (e.g., 0.08)
 *  - priceTLIinBTC
 *  - vestToTLIRatio
 *  - cumulativeVolumeBTC
 *  - monthlyVolumeBTC
 *  - cmgr12  (monthly CMGR, e.g., 0.05 = +5%/mo)
 *  - tlvestEffectiveSupply
 *  - vestV0BTC, vestVStarBTC, vestAlpha
 */
static computeTokensForTrade(trade, params) {
  const p = Object.assign({
    feeRate: 0.000005,
    baseRebateShare: 0.40,
    vipRebateShare: 0.20,
    dividendShareOfFees: 0.50,
    discountRateAnnual: 0.08,
    priceTLIinBTC: 0.00001,
    vestToTLIRatio: 1.0,
    cumulativeVolumeBTC: 1000000,
    monthlyVolumeBTC: 50000,
    cmgr12: 0.05,
    tlvestEffectiveSupply: 10000000,
    vestV0BTC: 100000,
    vestVStarBTC: 21000000,
    vestAlpha: 500000
  }, params || {});

  // BTC budget for this trade’s award (fee-budgeted; safe against wash)
  const feeBTC = p.feeRate * trade.notionalBtc;
  const awardValueBTC = feeBTC * (p.baseRebateShare + (trade.vip ? p.vipRebateShare : 0));

  // Growth & projection
  const gAnnual = this.annualizeFromCMGR(p.cmgr12);
  const r = Math.max(p.discountRateAnnual, 0.0001);
  const gCapped = Math.min(gAnnual, r - 0.01); // keep (r - g) >= 1%

  const projectedYearVolBTC = this.projectNextYearVolumeBTC(p.monthlyVolumeBTC, p.cmgr12);

  // Dividend-discount PV per TLVEST (Gordon)
  const feesPerYearBTC = p.feeRate * projectedYearVolBTC;
  const dividendPoolBTC = p.dividendShareOfFees * feesPerYearBTC;
  const perTokenDividendBTC = dividendPoolBTC / Math.max(p.tlvestEffectiveSupply, 1);
  const pvDividendBTC = perTokenDividendBTC / Math.max(r - gCapped, 0.01);

  // Conversion floor (TLI priced in BTC), discounted by vesting delay
  const months = this.monthsToReach(p.cumulativeVolumeBTC, p.vestVStarBTC, p.monthlyVolumeBTC, p.cmgr12);
  const vNow = this.vestFraction(p.cumulativeVolumeBTC, p.vestV0BTC, p.vestVStarBTC, p.vestAlpha);
  const df = this.discountFactorMonths(r, Math.max(0, months));
  const pvConversionBTC = p.priceTLIinBTC * p.vestToTLIRatio * (vNow + (1 - vNow) * df);

  // Conservative issuance: use the higher PV and ensure nonzero
  const pvTokenBTC = Math.max(pvDividendBTC, pvConversionBTC, this.EPS);
  const tokens = awardValueBTC / pvTokenBTC;

  return {
    tokens,
    awardValueBTC,
    pvTokenBTC,
    vestFractionNow: vNow,
    monthsToFullVest: months,
    components: {
      pvDividendBTC,
      pvConversionBTC,
      gAnnual,
      projectedYearVolumeBTC,
      perTokenDividendBTC,
      feeBTC
    }
  };
}

}

/** Example helper to compute monthly CMGR from your volume index series
 * (Pass in your last 12 monthly printed_btc values)
 */
// const cmgr12 = cmgrFromSeries(last12MonthsPrintedBTC);


module.exports = TradeLayerManager;

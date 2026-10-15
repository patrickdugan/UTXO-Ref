# Passes only for a healthy beta status. jq orders null below every number, so a missing field would satisfy
# "<= 12" or ">= .quorum" without this type check. Every numeric field is checked for its type first.
def isnum: type == "number";
def issats: type == "string" and test("^[0-9]+$");
(.betaReady == true) and
(.chain.network == "testnet4") and
(.chain.initialBlockDownload == false) and
(.chain.lagBlocks | isnum) and (.chain.lagBlocks <= 12) and
(.graph.verified == true) and
(.graph.graphHash == $graph) and
(.guardians.configured | isnum) and (.guardians.configured >= 2) and
(.guardians.fresh | isnum) and (.guardians.quorum | isnum) and (.guardians.fresh >= .guardians.quorum) and
(.guardians.quorumHealthy == true) and
(.guardianReserve.configured == true) and
(.guardianReserve.healthy == true) and
(.guardianReserve.unspent == true) and
(.guardianReserve.manifestVerified == true) and
(.guardianReserve.fundingHeightMatches == true) and
(.faucet.enabled == true) and
(.faucet.dailyRemainingSats | issats) and
(.faucet.amountSats | issats) and
((.faucet.dailyRemainingSats | tonumber) >= (.faucet.amountSats | tonumber))

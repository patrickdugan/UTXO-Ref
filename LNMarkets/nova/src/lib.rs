//! Nova constraints for the LNMarkets batch authorization statement.

pub mod nullifier;
pub mod nullifier_path;
pub mod outcome_membership;
pub mod settlement_amounts;
pub mod signing_digests;

const V1_CONTEXT_BYTES: usize = 180;
const V1_SUMMARY_BYTES: usize = 546;
const V1_OUTCOME_BYTES: usize = 68;

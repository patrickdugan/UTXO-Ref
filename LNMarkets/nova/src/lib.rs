//! Nova constraints for the LNMarkets batch authorization statement.

pub mod accepted_set;
pub mod authorization;
pub mod bip340;
pub mod journal_binding;
pub mod nullifier;
pub mod nullifier_batch;
pub mod nullifier_path;
pub mod outcome_membership;
mod payout_aggregation;
pub mod secp256k1;
pub mod settlement_amounts;
pub mod signing_digests;
pub mod summary_policy;
pub mod taproot_funding;
pub mod transaction_binding;
mod wire;
pub mod witness;

const V1_CONTEXT_BYTES: usize = 180;
const V1_SUMMARY_BYTES: usize = 546;
const V1_OUTCOME_BYTES: usize = 68;
const MAX_BATCH_ROWS: usize = 32;

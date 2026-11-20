//! Amount constraints for the pinned LNMarkets v1 batch statement.

use ff::{PrimeField, PrimeFieldBits};
use nova_snark::{
    frontend::{num::AllocatedNum, AllocatedBit, Boolean, ConstraintSystem, SynthesisError},
    traits::circuit::StepCircuit,
};

use crate::{V1_OUTCOME_BYTES, V1_SUMMARY_BYTES};

pub(crate) const MAX_MONEY: u64 = 21_000_000 * 100_000_000;
const MIN_OUTPUT_SATS: u64 = 330;
const MAX_ROW_FEE_SATS: u64 = 1_000_000;

/// Eight little-endian wire bytes, each represented by its MSB-first bits.
pub type AmountBits = [Boolean; 64];

/// Running totals in journal order: collateral, payouts including anchors, fees.
pub type Totals<F> = [AllocatedNum<F>; 3];

/// The same amount bits used in the signed v1 summary and selected outcome.
pub struct RowAmountBits {
    pub collateral: AmountBits,
    pub trader: AmountBits,
    pub maker: AmountBits,
    pub anchor: AmountBits,
    pub fee: AmountBits,
}

impl RowAmountBits {
    /// Share the exact encoded fields with the summary and outcome hashes.
    pub fn from_v1_wire(summary: &[Boolean], outcome: &[Boolean]) -> Result<Self, SynthesisError> {
        if summary.len() != V1_SUMMARY_BYTES * 8 || outcome.len() != V1_OUTCOME_BYTES * 8 {
            return Err(SynthesisError::Unsatisfiable(
                "invalid v1 summary or outcome bit length".into(),
            ));
        }
        let amount =
            |wire: &[Boolean], offset: usize| std::array::from_fn(|i| wire[offset * 8 + i].clone());
        Ok(Self {
            collateral: amount(summary, 164),
            trader: amount(outcome, 36),
            maker: amount(outcome, 44),
            anchor: amount(outcome, 52),
            fee: amount(outcome, 60),
        })
    }
}

/// Apply one row to the running totals. A batch circuit starts from zero
/// and binds the final totals to the independently retained public journal.
pub fn apply_row<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    cs: &mut CS,
    prior: &Totals<F>,
    row: &RowAmountBits,
) -> Result<Totals<F>, SynthesisError> {
    if F::CAPACITY < 67 {
        return Err(SynthesisError::Unsatisfiable(
            "settlement amount constraints need a field with 67 bits of capacity".into(),
        ));
    }
    let collateral = wire_amount(
        cs.namespace(|| "collateral"),
        &row.collateral,
        991,
        MAX_MONEY,
    )?;
    let trader = wire_amount(
        cs.namespace(|| "trader"),
        &row.trader,
        MIN_OUTPUT_SATS,
        MAX_MONEY,
    )?;
    let maker = wire_amount(
        cs.namespace(|| "maker"),
        &row.maker,
        MIN_OUTPUT_SATS,
        MAX_MONEY,
    )?;
    let anchor = wire_amount(
        cs.namespace(|| "anchor"),
        &row.anchor,
        MIN_OUTPUT_SATS,
        MAX_MONEY,
    )?;
    let fee = wire_amount(cs.namespace(|| "fee"), &row.fee, 1, MAX_ROW_FEE_SATS)?;
    let payout = sum(cs.namespace(|| "row payout"), &[&trader, &maker, &anchor])?;
    cs.enforce(
        || "payout plus fee equals collateral",
        |lc| lc + payout.get_variable() + fee.get_variable(),
        |lc| lc + CS::one(),
        |lc| lc + collateral.get_variable(),
    );

    let mut totals = Vec::with_capacity(3);
    for (index, amount) in [collateral, payout, fee].iter().enumerate() {
        let mut ns = cs.namespace(|| format!("total {index}"));
        bounded_total(ns.namespace(|| "prior"), &prior[index])?;
        let next = sum(ns.namespace(|| "add row"), &[&prior[index], amount])?;
        bounded_total(ns.namespace(|| "next"), &next)?;
        totals.push(next);
    }
    Ok(totals.try_into().unwrap())
}

pub(crate) fn wire_amount<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    wire: &AmountBits,
    minimum: u64,
    maximum: u64,
) -> Result<AllocatedNum<F>, SynthesisError> {
    let bits: [Boolean; 64] = std::array::from_fn(|i| wire[i ^ 7].clone());
    at_most(cs.namespace(|| "maximum"), &bits, maximum)?;
    at_most(
        cs.namespace(|| "minimum"),
        &bits.clone().map(|bit| bit.not()),
        !minimum,
    )?;
    let value = AllocatedNum::alloc(cs.namespace(|| "amount"), || {
        bits.iter()
            .rev()
            .try_fold(0u64, |value, bit| {
                bit.get_value().map(|bit| (value << 1) | u64::from(bit))
            })
            .map(F::from)
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    cs.enforce(
        || "amount equals wire bits",
        |mut lc| {
            for (i, bit) in bits.iter().enumerate() {
                lc = lc + &bit.lc(CS::one(), F::from(1u64 << i));
            }
            lc
        },
        |lc| lc + CS::one(),
        |lc| lc + value.get_variable(),
    );
    Ok(value)
}

fn at_most<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bits: &[Boolean],
    bound: u64,
) -> Result<(), SynthesisError> {
    let mut equal = Boolean::constant(true);
    for (index, bit) in bits.iter().enumerate().rev() {
        let mut ns = cs.namespace(|| format!("bit {index}"));
        if (bound >> index) & 1 == 0 {
            let exceeds = Boolean::and(ns.namespace(|| "exceeds bound"), &equal, bit)?;
            Boolean::enforce_equal(
                ns.namespace(|| "in range"),
                &exceeds,
                &Boolean::constant(false),
            )?;
            // Once the prefix is smaller, it cannot become equal again.
            // When it is equal, "in range" has already forced this bit to zero.
        } else {
            equal = Boolean::and(ns.namespace(|| "prefix equal"), &equal, bit)?;
        }
    }
    Ok(())
}

fn bounded_total<F: PrimeFieldBits, CS: ConstraintSystem<F>>(
    mut cs: CS,
    value: &AllocatedNum<F>,
) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le(cs.namespace(|| "total bits"))?;
    // MAX_MONEY < 2^51. These constraints also eliminate field aliases.
    for (i, bit) in bits[51..].iter().enumerate() {
        Boolean::enforce_equal(
            cs.namespace(|| format!("high bit {i}")),
            bit,
            &Boolean::constant(false),
        )?;
    }
    at_most(cs.namespace(|| "money range"), &bits[..51], MAX_MONEY)
}

fn sum<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    terms: &[&AllocatedNum<F>],
) -> Result<AllocatedNum<F>, SynthesisError> {
    let result = AllocatedNum::alloc(cs.namespace(|| "sum"), || {
        terms
            .iter()
            .try_fold(F::ZERO, |acc, term| {
                term.get_value().map(|value| acc + value)
            })
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    cs.enforce(
        || "sum equals terms",
        |lc| terms.iter().fold(lc, |acc, term| acc + term.get_variable()),
        |lc| lc + CS::one(),
        |lc| lc + result.get_variable(),
    );
    Ok(result)
}

/// A standalone fold step for testing the amount subrelation.
#[derive(Clone, Debug)]
pub struct SettlementAmountStep {
    pub collateral: u64,
    pub trader: u64,
    pub maker: u64,
    pub anchor: u64,
    pub fee: u64,
}

impl<F: PrimeFieldBits> StepCircuit<F> for SettlementAmountStep {
    fn arity(&self) -> usize {
        3
    }

    fn synthesize<CS: ConstraintSystem<F>>(
        &self,
        cs: &mut CS,
        z: &[AllocatedNum<F>],
    ) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        let prior: &Totals<F> = z.try_into().map_err(|_| {
            SynthesisError::Unsatisfiable("invalid settlement total state arity".into())
        })?;
        let row = RowAmountBits {
            collateral: allocate_wire(cs.namespace(|| "collateral bytes"), self.collateral)?,
            trader: allocate_wire(cs.namespace(|| "trader bytes"), self.trader)?,
            maker: allocate_wire(cs.namespace(|| "maker bytes"), self.maker)?,
            anchor: allocate_wire(cs.namespace(|| "anchor bytes"), self.anchor)?,
            fee: allocate_wire(cs.namespace(|| "fee bytes"), self.fee)?,
        };
        Ok(apply_row(cs, prior, &row)?.into())
    }
}

fn allocate_wire<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    value: u64,
) -> Result<AmountBits, SynthesisError> {
    let bits = (0..64)
        .map(|i| {
            AllocatedBit::alloc(
                cs.namespace(|| format!("bit {i}")),
                Some((value >> (i ^ 7)) & 1 != 0),
            )
            .map(Boolean::from)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(bits.try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use nova_snark::{
        frontend::test_cs::TestConstraintSystem, provider::Bn256EngineIPA, traits::Engine,
    };

    type F = <Bn256EngineIPA as Engine>::Scalar;

    fn input(cs: &mut TestConstraintSystem<F>, totals: [u64; 3]) -> Vec<AllocatedNum<F>> {
        totals
            .iter()
            .enumerate()
            .map(|(index, value)| {
                AllocatedNum::alloc(cs.namespace(|| format!("input {index}")), || {
                    Ok(F::from(*value))
                })
                .unwrap()
            })
            .collect()
    }

    const ROW_ONE: SettlementAmountStep = SettlementAmountStep {
        collateral: 401_330,
        trader: 88_889,
        maker: 311_111,
        anchor: 330,
        fee: 1_000,
    };
    const ROW_TWO: SettlementAmountStep = SettlementAmountStep {
        collateral: 401_330,
        trader: 290_909,
        maker: 109_091,
        anchor: 330,
        fee: 1_000,
    };

    #[test]
    fn saved_rows_produce_the_exact_journal_totals() {
        let journal = include_bytes!("../../evidence/sp1-two-trade-journal.bin");
        let mut cs = TestConstraintSystem::<F>::new();
        let mut totals = input(&mut cs, [0; 3]);
        for (i, row) in [ROW_ONE, ROW_TWO].into_iter().enumerate() {
            let mut ns = cs.namespace(|| format!("row {i}"));
            let mut summary = vec![Boolean::constant(false); V1_SUMMARY_BYTES * 8];
            let mut outcome = vec![Boolean::constant(false); V1_OUTCOME_BYTES * 8];
            summary[164 * 8..172 * 8].clone_from_slice(
                &allocate_wire(ns.namespace(|| "summary collateral"), row.collateral).unwrap(),
            );
            for (offset, amount) in [
                (36, row.trader),
                (44, row.maker),
                (52, row.anchor),
                (60, row.fee),
            ] {
                outcome[offset * 8..(offset + 8) * 8].clone_from_slice(
                    &allocate_wire(ns.namespace(|| format!("outcome byte {offset}")), amount)
                        .unwrap(),
                );
            }
            let fields = RowAmountBits::from_v1_wire(&summary, &outcome).unwrap();
            totals = apply_row(&mut ns, totals.as_slice().try_into().unwrap(), &fields)
                .unwrap()
                .into();
        }
        for (num, bytes) in totals.iter().zip(journal[252..276].chunks_exact(8)) {
            let expected = u64::from_le_bytes(bytes.try_into().unwrap());
            assert_eq!(num.get_value(), Some(F::from(expected)));
        }
        assert!(cs.is_satisfied());
    }

    #[test]
    fn rejects_dust_invalid_fee_tie_out_and_batch_overflow() {
        let cases = [
            (
                SettlementAmountStep {
                    trader: ROW_ONE.trader + 1,
                    ..ROW_ONE
                },
                [0; 3],
            ),
            (
                SettlementAmountStep {
                    anchor: 329,
                    trader: ROW_ONE.trader + 1,
                    ..ROW_ONE
                },
                [0; 3],
            ),
            (
                SettlementAmountStep {
                    fee: 0,
                    trader: ROW_ONE.trader + ROW_ONE.fee,
                    ..ROW_ONE
                },
                [0; 3],
            ),
            (
                SettlementAmountStep {
                    fee: MAX_ROW_FEE_SATS + 1,
                    collateral: 1_400_331,
                    ..ROW_ONE
                },
                [0; 3],
            ),
            (ROW_ONE, [MAX_MONEY, MAX_MONEY, 0]),
        ];
        for (row, totals) in cases {
            let mut cs = TestConstraintSystem::<F>::new();
            let initial = input(&mut cs, totals);
            row.synthesize(&mut cs, &initial).unwrap();
            assert!(!cs.is_satisfied());
        }
    }

    #[test]
    fn rejects_wrapped_running_total() {
        let mut cs = TestConstraintSystem::<F>::new();
        let mut prior = input(&mut cs, [0; 3]);
        prior[0] = AllocatedNum::alloc(cs.namespace(|| "wrapped total"), || Ok(-F::ONE)).unwrap();
        ROW_ONE.synthesize(&mut cs, &prior).unwrap();
        assert!(!cs.is_satisfied());
    }
}

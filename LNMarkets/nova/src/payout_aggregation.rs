use ff::PrimeField;
use nova_snark::frontend::{
    num::AllocatedNum, AllocatedBit, Boolean, ConstraintSystem, SynthesisError,
};

use crate::settlement_amounts::{
    wire_amount, AmountBits, RowAmountBits, MAX_MONEY, MIN_OUTPUT_SATS,
};
use crate::transaction_binding::SettlementRowBits;

const SCRIPT_BITS: usize = 34 * 8;
const SCRIPT_LIMB_BITS: usize = SCRIPT_BITS / 2;

struct Output<F: PrimeField> {
    script: [AllocatedNum<F>; 2],
    value: AllocatedNum<F>,
    contributions: Vec<AllocatedNum<F>>,
}

/// The caller has already checked the candidate's canonical output layout.
pub(crate) fn enforce_aggregated_outputs<'a, F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    rows: &[SettlementRowBits<'_>],
    candidate: impl Iterator<Item = &'a [Boolean]>,
) -> Result<(), SynthesisError> {
    if F::CAPACITY < SCRIPT_LIMB_BITS as u32 {
        return Err(SynthesisError::Unsatisfiable(
            "script matching needs 136 field bits".into(),
        ));
    }
    let mut outputs = Vec::new();
    for (index, wire) in candidate.enumerate() {
        let mut ns = cs.namespace(|| format!("output {index}"));
        // 8 value bytes, one 34-byte script length, then the script.
        let value = wire_amount(
            ns.namespace(|| "output value"),
            wire[..64].try_into().unwrap(),
            MIN_OUTPUT_SATS,
            MAX_MONEY,
        )?;
        let script = pack_script(ns.namespace(|| "output script"), &wire[9 * 8..])?;
        outputs.push(Output {
            script,
            value,
            contributions: Vec::new(),
        });
    }

    for (index, row) in rows.iter().enumerate() {
        let mut ns = cs.namespace(|| format!("row {index}"));
        let amounts = RowAmountBits::from_v1_wire(row.summary, row.outcome)?;
        for (role, offset, amount) in [
            ("trader", 270, &amounts.trader),
            ("maker", 304, &amounts.maker),
            ("anchor", 338, &amounts.anchor),
        ] {
            route_payout(
                ns.namespace(|| role),
                &row.summary[offset * 8..(offset + 34) * 8],
                amount,
                &mut outputs,
            )?;
        }
    }

    for (index, output) in outputs.iter().enumerate() {
        cs.enforce(
            || format!("output {index} equals matched payouts"),
            |lc| {
                output
                    .contributions
                    .iter()
                    .fold(lc, |sum, payout| sum + payout.get_variable())
            },
            |lc| lc + CS::one(),
            |lc| lc + output.value.get_variable(),
        );
    }
    Ok(())
}

fn route_payout<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    script: &[Boolean],
    amount: &AmountBits,
    outputs: &mut [Output<F>],
) -> Result<(), SynthesisError> {
    let script = pack_script(cs.namespace(|| "payout script"), script)?;
    let payout = wire_amount(
        cs.namespace(|| "payout value"),
        amount,
        MIN_OUTPUT_SATS,
        MAX_MONEY,
    )?;
    let mut matches = Vec::with_capacity(outputs.len());
    for (index, output) in outputs.iter_mut().enumerate() {
        let mut ns = cs.namespace(|| format!("candidate output {index}"));
        let first = equal_limb(
            ns.namespace(|| "first script limb"),
            &script[0],
            &output.script[0],
        )?;
        let second = equal_limb(
            ns.namespace(|| "second script limb"),
            &script[1],
            &output.script[1],
        )?;
        let matched = Boolean::and(ns.namespace(|| "exact script match"), &first, &second)?;
        let contribution = AllocatedNum::alloc(ns.namespace(|| "contribution"), || {
            matched
                .get_value()
                .zip(payout.get_value())
                .map(|(matched, amount)| if matched { amount } else { F::ZERO })
                .ok_or(SynthesisError::AssignmentMissing)
        })?;
        ns.enforce(
            || "only a matched script receives the amount",
            |lc| lc + &matched.lc(CS::one(), F::ONE),
            |lc| lc + payout.get_variable(),
            |lc| lc + contribution.get_variable(),
        );
        matches.push(matched);
        output.contributions.push(contribution);
    }
    cs.enforce(
        || "payout has exactly one candidate output",
        |lc| {
            matches
                .iter()
                .fold(lc, |sum, matched| sum + &matched.lc(CS::one(), F::ONE))
        },
        |lc| lc + CS::one(),
        |lc| lc + CS::one(),
    );
    Ok(())
}

fn pack_script<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bits: &[Boolean],
) -> Result<[AllocatedNum<F>; 2], SynthesisError> {
    Ok([
        pack_limb(
            cs.namespace(|| "high script limb"),
            &bits[..SCRIPT_LIMB_BITS],
        )?,
        pack_limb(
            cs.namespace(|| "low script limb"),
            &bits[SCRIPT_LIMB_BITS..],
        )?,
    ])
}

fn pack_limb<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    bits: &[Boolean],
) -> Result<AllocatedNum<F>, SynthesisError> {
    let value = AllocatedNum::alloc(cs.namespace(|| "script limb"), || {
        bits.iter()
            .try_fold(F::ZERO, |value, bit| {
                bit.get_value()
                    .map(|bit| value.double() + F::from(u64::from(bit)))
            })
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    cs.enforce(
        || "limb represents every script bit",
        |mut lc| {
            let mut weight = F::ONE;
            for bit in bits.iter().rev() {
                lc = lc + &bit.lc(CS::one(), weight);
                weight = weight.double();
            }
            lc
        },
        |lc| lc + CS::one(),
        |lc| lc + value.get_variable(),
    );
    Ok(value)
}

fn equal_limb<F: PrimeField, CS: ConstraintSystem<F>>(
    mut cs: CS,
    left: &AllocatedNum<F>,
    right: &AllocatedNum<F>,
) -> Result<Boolean, SynthesisError> {
    let difference = left
        .get_value()
        .zip(right.get_value())
        .map(|(left, right)| left - right);
    let equal = AllocatedBit::alloc(
        cs.namespace(|| "equal"),
        difference.map(|d| bool::from(d.is_zero())),
    )?;
    let inverse = AllocatedNum::alloc(cs.namespace(|| "inverse for unequal limbs"), || {
        difference
            .map(|d| d.invert().unwrap_or(F::ZERO))
            .ok_or(SynthesisError::AssignmentMissing)
    })?;
    cs.enforce(
        || "an equal pair has zero difference",
        |lc| lc + left.get_variable() - right.get_variable(),
        |lc| lc + equal.get_variable(),
        |lc| lc,
    );
    cs.enforce(
        || "an unequal pair has invertible difference",
        |lc| lc + left.get_variable() - right.get_variable(),
        |lc| lc + inverse.get_variable(),
        |lc| lc + CS::one() - equal.get_variable(),
    );
    Ok(equal.into())
}

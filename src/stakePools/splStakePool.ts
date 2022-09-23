import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AccountInfo,
  PublicKey,
  StakeAuthorizationLayout,
  StakeProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { AccountInfoMap, Quote } from "@jup-ag/core/dist/lib/amm";
import { stakeAccountState } from "@soceanfi/solana-stake-sdk";
// NOTE:
// Seems like current spl-stake-pool version [0.7.0](https://github.com/solana-labs/solana-program-library/blob/stake-pool-v0.7.0/stake-pool/program/src/processor.rs)
// is still compatible with our stake-pool-sdk for depositStake instruction
import {
  calcStakeDeposit,
  decodeStakePool,
  decodeValidatorList,
  depositStakeInstruction,
  Numberu64,
  StakePool as SplStakePoolStruct,
  ValidatorList,
} from "@soceanfi/stake-pool-sdk";
import { BN } from "bn.js";
import JSBI from "jsbi";

import type {
  CanAcceptStakeAccountParams,
  CreateSetupInstructionsParams,
  CreateSwapInstructionsParams,
  StakePool,
  StakePoolQuoteParams,
} from "@/unstake-ag/stakePools";

interface SplStakePoolCtorParams {
  validatorListAddr: PublicKey;
  outputToken: PublicKey;
  label: string;
}

export class SplStakePool implements StakePool {
  outputToken: PublicKey;

  label: string;

  // accounts cache
  stakePool: SplStakePoolStruct | null;

  validatorList: ValidatorList | null;

  // addr cache
  programId: PublicKey;

  stakePoolAddr: PublicKey;

  validatorListAddr: PublicKey;

  constructor(
    stakePoolAddr: PublicKey,
    // just pass in an AccountInfo with the right owner
    // and not use the data since we're gonna call fetch all accounts and update() anyway
    stakePoolAccountInfo: AccountInfo<Buffer>,
    { validatorListAddr, outputToken, label }: SplStakePoolCtorParams,
  ) {
    this.outputToken = outputToken;
    this.label = label;

    this.stakePool = null;
    this.validatorList = null;

    this.programId = stakePoolAccountInfo.owner;
    this.stakePoolAddr = stakePoolAddr;
    this.validatorListAddr = validatorListAddr;
  }

  /**
   * SPL stake pools only accept active stake accounts staked to validators
   * in the validator list
   * @param param0
   */
  canAcceptStakeAccount({
    stakeAccount,
    currentEpoch,
  }: CanAcceptStakeAccountParams): boolean {
    if (!this.validatorList) {
      throw new Error("validator list not yet fetched");
    }
    const state = stakeAccountState(stakeAccount.data, new BN(currentEpoch));
    if (
      state === "inactive" ||
      state === "activating" ||
      !stakeAccount.data.info.stake
    ) {
      return false;
    }
    const { voter } = stakeAccount.data.info.stake.delegation;
    return Boolean(
      this.validatorList.validators.find((validator) =>
        validator.voteAccountAddress.equals(voter),
      ),
    );
  }

  // eslint-disable-next-line class-methods-use-this
  createSetupInstructions({
    currentEpoch,
    stakeAccount,
    stakeAccountPubkey,
    stakerAuth,
  }: CreateSetupInstructionsParams): TransactionInstruction[] {
    // reactivate if deactivating
    const state = stakeAccountState(stakeAccount.data, new BN(currentEpoch));
    if (state === "deactivating") {
      if (!stakeAccount.data.info.stake) {
        throw new Error("stakeAccount.data.info.stake null");
      }
      return StakeProgram.delegate({
        authorizedPubkey: stakerAuth,
        stakePubkey: stakeAccountPubkey,
        votePubkey: stakeAccount.data.info.stake.delegation.voter,
      }).instructions;
    }
    return [];
  }

  createSwapInstructions({
    stakeAccountPubkey,
    stakerAuth,
    withdrawerAuth,
    destinationTokenAccount,
    stakeAccountVotePubkey,
  }: CreateSwapInstructionsParams): TransactionInstruction[] {
    if (!this.stakePool) {
      throw new Error("stakePool not fetched");
    }

    // TODO: export sync versions of these PDA util functions
    // from stake-pool-sdk
    const [stakePoolWithdrawAuth] = PublicKey.findProgramAddressSync(
      [this.stakePoolAddr.toBuffer(), Buffer.from("withdraw")],
      this.programId,
    );
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [stakeAccountVotePubkey.toBuffer(), this.stakePoolAddr.toBuffer()],
      this.programId,
    );
    return [
      ...StakeProgram.authorize({
        stakePubkey: stakeAccountPubkey,
        authorizedPubkey: stakerAuth,
        newAuthorizedPubkey: this.stakePool.depositAuthority,
        stakeAuthorizationType: StakeAuthorizationLayout.Staker,
      }).instructions,
      ...StakeProgram.authorize({
        stakePubkey: stakeAccountPubkey,
        authorizedPubkey: withdrawerAuth,
        newAuthorizedPubkey: this.stakePool.depositAuthority,
        stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
      }).instructions,
      depositStakeInstruction(
        this.programId,
        this.stakePoolAddr,
        this.validatorListAddr,
        this.stakePool.depositAuthority,
        stakePoolWithdrawAuth,
        stakeAccountPubkey,
        validatorStakeAccount,
        this.stakePool.reserveStake,
        destinationTokenAccount,
        this.stakePool.managerFeeAccount,
        // no referrer
        this.stakePool.managerFeeAccount,
        this.stakePool.poolMint,
        TOKEN_PROGRAM_ID,
      ),
    ];
  }

  // eslint-disable-next-line class-methods-use-this
  createCleanupInstruction(): TransactionInstruction[] {
    return [];
  }

  getAccountsForUpdate(): PublicKey[] {
    return [this.stakePoolAddr, this.validatorListAddr];
  }

  update(accountInfoMap: AccountInfoMap): void {
    const stakePool = accountInfoMap.get(this.stakePoolAddr.toString());
    if (stakePool) {
      this.stakePool = decodeStakePool(stakePool.data);
    }
    const validatorList = accountInfoMap.get(this.validatorListAddr.toString());
    if (validatorList) {
      this.validatorList = decodeValidatorList(validatorList.data);
    }
  }

  getQuote({ amount }: StakePoolQuoteParams): Quote {
    if (!this.stakePool) {
      throw new Error("stakePool not fetched");
    }
    const { dropletsReceived, dropletsFeePaid } = calcStakeDeposit(
      new Numberu64(amount.toString()),
      this.stakePool,
    );
    const outAmount = JSBI.BigInt(dropletsReceived.toString());
    return {
      notEnoughLiquidity: false,
      minOutAmount: outAmount,
      inAmount: amount,
      outAmount,
      feeAmount: JSBI.BigInt(dropletsFeePaid.toString()),
      feeMint: this.outputToken.toString(),
      // Note: name is pct, but actually rate (0.0 - 1.0)
      feePct:
        dropletsFeePaid.toNumber() /
        dropletsFeePaid.add(dropletsReceived).toNumber(),
      priceImpactPct: 0,
    };
  }
}
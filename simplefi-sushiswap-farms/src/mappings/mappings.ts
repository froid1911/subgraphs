import { Address, BigInt, ethereum, store } from "@graphprotocol/graph-ts";

import {
  MasterChefV2,
  Deposit,
  Withdraw,
  EmergencyWithdraw,
  Harvest,
  LogPoolAddition,
  LogUpdatePool,
  LogSetPool,
} from "../../generated/MasterChefV2/MasterChefV2";

import { Transfer } from "../../generated/templates/RewardToken/IERC20";

import { IRewarder } from "../../generated/MasterChefV2/IRewarder";

import {
  SushiFarm,
  SushiFarmSnapshot,
  FarmDeposit,
  FarmWithdrawal,
  UserInfo,
  Market,
  Account,
  Token,
  SushiRewardTransfer,
  ExtraRewardTokenTransfer,
  MasterChef,
  Rewarder,
} from "../../generated/schema";

import {
  getOrCreateERC20Token,
  getOrCreateMarketWithId,
  getOrCreateAccount,
  updateMarket,
  investInMarket,
  redeemFromMarket,
  TokenBalance,
  ADDRESS_ZERO,
} from "../library/common";

import { RewardToken } from "../../generated/templates";

import { ProtocolName, ProtocolType } from "../library/constants";

// hard-coded as in contract
let ACC_SUSHI_PRECISION: BigInt = BigInt.fromI32(10).pow(12);

/**
 * Handle creation of new Sushi farm.
 * @param event
 */
export function handleLogPoolAddition(event: LogPoolAddition): void {
  let masterChef = MasterChef.load(event.address.toHexString());

  // create MasterChef entity and store Sushi token address
  if (masterChef == null) {
    masterChef = new MasterChef(event.address.toHexString());

    // get sushi address, store it and start indexer if needed
    let masterChefContract = MasterChefV2.bind(event.address);
    let sushi = masterChefContract.SUSHI();

    let token = Token.load(sushi.toHexString());
    if (token == null) {
      // start indexing SUSHI events
      RewardToken.create(sushi);
    }
    let sushiToken = getOrCreateERC20Token(event, sushi);
    masterChef.sushi = sushiToken.id;
    masterChef.save();
  }

  // create Rewarder entity
  let rewarderAddress = event.params.rewarder.toHexString();
  let rewarder = Rewarder.load(rewarderAddress);
  if (rewarder == null) {
    rewarder = new Rewarder(rewarderAddress);
    rewarder.save();
  }

  // create and fill SushiFarm entity
  let sushiFarm = new SushiFarm(event.params.pid.toString());
  sushiFarm.masterChef = masterChef.id;
  sushiFarm.rewarder = rewarder.id;
  sushiFarm.allocPoint = event.params.allocPoint;
  sushiFarm.created = event.block.timestamp;
  sushiFarm.createdAtBlock = event.block.number;
  sushiFarm.createdAtTransaction = event.transaction.hash;
  sushiFarm.totalSupply = BigInt.fromI32(0);
  let inputToken = getOrCreateERC20Token(event, event.params.lpToken);
  sushiFarm.lpToken = inputToken.id;
  sushiFarm.lastRewardBlock = event.block.number;
  sushiFarm.accSushiPerShare = BigInt.fromI32(0);
  sushiFarm.save();

  // create market representing the farm
  let marketId = sushiFarm.masterChef + "-" + sushiFarm.id;
  let marketAddress = Address.fromString(sushiFarm.masterChef);
  let protocolName = ProtocolName.SUSHISWAP_FARM;
  let protocolType = ProtocolType.TOKEN_MANAGEMENT;
  let inputTokens: Token[] = [inputToken];
  let rewardTokens: Token[] = getRewardTokens(sushiFarm, event);

  getOrCreateMarketWithId(
    event,
    marketId,
    marketAddress,
    protocolName,
    protocolType,
    inputTokens,
    null,
    rewardTokens
  );
}

/**
 * User deposits his LP tokens to farm. Receiver of deposit benefits doesn't have to necessarily be
 * account which triggered the Deposit.
 * @param event
 * @returns
 */
export function handleDeposit(event: Deposit): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;
  let user = getOrCreateAccount(event.params.user);
  let receiver = getOrCreateAccount(event.params.to);
  let amount = event.params.amount;

  // save new deposit entity
  let deposit = new FarmDeposit(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toHexString()
  );
  deposit.transactionHash = event.transaction.hash.toHexString();
  deposit.sushiFarm = sushiFarm.id;
  deposit.depositer = user.id;
  deposit.depositReceiver = receiver.id;
  deposit.amount = amount;
  deposit.save();

  // don't update user's position for 0 value deposit
  if (deposit.amount == BigInt.fromI32(0)) {
    return;
  }

  // increase user's balance of provided LP tokens and amount of rewards entitled to user
  let userInfo = getOrCreateUserInfo(deposit.depositReceiver, sushiFarm.id);
  userInfo.amount = userInfo.amount.plus(amount);
  userInfo.rewardDebt = userInfo.rewardDebt.plus(
    amount.times(sushiFarm.accSushiPerShare).div(ACC_SUSHI_PRECISION)
  );
  userInfo.save();

  ////// update user's position

  let masterChef = event.address.toHexString();
  let market = Market.load(masterChef + "-" + sushiFarm.id) as Market;

  // sushi farms don't have output token
  let outputTokenAmount = BigInt.fromI32(0);

  // user deposited `amount` LP tokens
  let inputTokenAmounts: TokenBalance[] = [
    new TokenBalance(sushiFarm.lpToken, deposit.depositReceiver, amount),
  ];

  // number of reward tokens claimed by user in this transaction
  let rewardTokenAmounts: TokenBalance[] = [];

  // total number of farm ownership tokens owned by user - 0 because sushi farms don't have token
  let outputTokenBalance = BigInt.fromI32(0);

  // inputTokenBalance -> number of LP tokens that can be redeemed by user
  let inputTokenBalances: TokenBalance[] = [];
  inputTokenBalances.push(
    new TokenBalance(sushiFarm.lpToken, deposit.depositReceiver, userInfo.amount)
  );

  // reward token amounts (SUSHI + custom tokens) claimable by user
  let rewardTokenBalances: TokenBalance[] = [];
  collectRewardTokenBalances(sushiFarm, receiver, rewardTokenBalances, market);

  investInMarket(
    event,
    receiver,
    market,
    outputTokenAmount,
    inputTokenAmounts,
    rewardTokenAmounts,
    outputTokenBalance,
    inputTokenBalances,
    rewardTokenBalances,
    null
  );
}

/**
 * In Withdraw user gets his LP tokens back from farm and potentially rewards. Receiver doesn't have
 * to necessarily be account which triggered the Withdraw.
 * @param event
 * @returns
 */
export function handleWithdraw(event: Withdraw): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;
  let user = getOrCreateAccount(event.params.user);
  let receiver = getOrCreateAccount(event.params.to);
  let amount = event.params.amount;

  // save new withdrawal entity
  let withdrawal = new FarmWithdrawal(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toHexString()
  );
  withdrawal.transactionHash = event.transaction.hash.toHexString();
  withdrawal.sushiFarm = sushiFarm.id;
  withdrawal.withdrawer = user.id;
  withdrawal.withdrawalReceiver = receiver.id;
  withdrawal.amount = amount;
  withdrawal.save();

  // don't update user's position for 0 value withdrawal
  if (withdrawal.amount == BigInt.fromI32(0)) {
    return;
  }

  // decrease user's balance of provided LP tokens and amount of rewards entitled to user
  let userInfo = getOrCreateUserInfo(user.id, sushiFarm.id);
  userInfo.amount = userInfo.amount.minus(amount);
  userInfo.rewardDebt = userInfo.rewardDebt.minus(
    amount.times(sushiFarm.accSushiPerShare).div(ACC_SUSHI_PRECISION)
  );
  userInfo.save();

  ////// update user's position

  let masterChef = event.address.toHexString();
  let market = Market.load(masterChef + "-" + sushiFarm.id) as Market;

  // sushi farms don't have output token
  let outputTokenAmount = BigInt.fromI32(0);

  // user withdrew `amount` LP tokens
  let inputTokenAmounts: TokenBalance[] = [
    new TokenBalance(sushiFarm.lpToken, withdrawal.withdrawalReceiver, amount),
  ];

  // number of reward tokens claimed by user in this transaction
  let rewardTokenAmounts: TokenBalance[] = [];
  getHarvestedRewards(event, market, rewardTokenAmounts);

  // total number of farm ownership tokens owned by user - 0 because sushi farms don't have token
  let outputTokenBalance = BigInt.fromI32(0);

  // inputTokenBalance -> number of LP tokens that can be redeemed by user
  let inputTokenBalances: TokenBalance[] = [];
  inputTokenBalances.push(
    new TokenBalance(sushiFarm.lpToken, withdrawal.withdrawalReceiver, userInfo.amount)
  );

  // reward token amounts (SUSHI + custom tokens) claimable by user
  let rewardTokenBalances: TokenBalance[] = [];
  collectRewardTokenBalances(sushiFarm, user, rewardTokenBalances, market);

  redeemFromMarket(
    event,
    receiver,
    market,
    outputTokenAmount,
    inputTokenAmounts,
    rewardTokenAmounts,
    outputTokenBalance,
    inputTokenBalances,
    rewardTokenBalances,
    null
  );
}

/**
 * In EmergencyWithdraw user gets his LP tokens back from farm, but no rewards. Receiver doesn't have
 * to necessarily be account which triggered the EmergencyWithdraw
 * @param event
 * @returns
 */
export function handleEmergencyWithdraw(event: EmergencyWithdraw): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;
  let user = getOrCreateAccount(event.params.user);
  let receiver = getOrCreateAccount(event.params.to);
  let amount = event.params.amount;

  // save new withdrawal entity
  let withdrawal = new FarmWithdrawal(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toHexString()
  );
  withdrawal.transactionHash = event.transaction.hash.toHexString();
  withdrawal.sushiFarm = sushiFarm.id;
  withdrawal.withdrawer = user.id;
  withdrawal.withdrawalReceiver = receiver.id;
  withdrawal.amount = amount;
  withdrawal.save();

  // don't update user's position for empty emergency withdrawal
  if (withdrawal.amount == BigInt.fromI32(0)) {
    return;
  }

  ////// update user's position

  let masterChef = event.address.toHexString();
  let market = Market.load(masterChef + "-" + sushiFarm.id) as Market;

  // LP token balance and claimable rewards are resetted to 0 in EmergencyWithdraw
  let userInfo = getOrCreateUserInfo(receiver.id, sushiFarm.id);
  userInfo.amount = BigInt.fromI32(0);
  userInfo.rewardDebt = BigInt.fromI32(0);
  userInfo.save();

  // no output token in sushi farms
  let outputTokenAmount = BigInt.fromI32(0);

  // LP tokens go to receiver
  let inputTokenAmounts: TokenBalance[] = [
    new TokenBalance(sushiFarm.lpToken, withdrawal.withdrawalReceiver, amount),
  ];

  // number of reward tokens claimed by user in this transaction
  let rewardTokenAmounts: TokenBalance[] = [];

  // total number of farm ownership tokens owned by user - 0 because sushi farms don't have token
  let outputTokenBalance = BigInt.fromI32(0);

  // inputTokenBalance -> number of LP tokens that can be redeemed by user
  let inputTokenBalances: TokenBalance[] = [];
  inputTokenBalances.push(
    new TokenBalance(sushiFarm.lpToken, withdrawal.withdrawalReceiver, userInfo.amount)
  );

  // reward token amounts (SUSHI + custom tokens) claimable by user
  let rewardTokenBalances: TokenBalance[] = [];
  collectRewardTokenBalances(sushiFarm, user, rewardTokenBalances, market);

  redeemFromMarket(
    event,
    receiver,
    market,
    outputTokenAmount,
    inputTokenAmounts,
    rewardTokenAmounts,
    outputTokenBalance,
    inputTokenBalances,
    rewardTokenBalances,
    null
  );
}

/**
 * Harvest means claiming the Sushi rewards as well as other reward tokens. Receiver of the rewards
 * doesn't have to be necessarily user who triggered the harvest.
 * @param event
 * @returns
 */
export function handleHarvest(event: Harvest): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;
  let harvester = getOrCreateAccount(event.params.user);
  let harvestedSushiAmount = event.params.amount;

  // if there are no unprocessed reward transfers then don't do anything, as it means they were already
  // handled in handleWithdraw
  let masterChef = event.address.toHexString();
  let market = Market.load(masterChef + "-" + sushiFarm.id) as Market;
  if (!isThereUnprocessedRewardTransfer(market, event)) {
    return;
  }

  // don't update user's position for 0 value harvest
  if (harvestedSushiAmount == BigInt.fromI32(0)) {
    return;
  }

  // updated user's rewardDebt which tracks total amount of claimed Sushi tokens
  let userInfo = getOrCreateUserInfo(harvester.id, sushiFarm.id);
  userInfo.rewardDebt = userInfo.rewardDebt.plus(harvestedSushiAmount);
  userInfo.save();

  ////// update user's position

  // sushi farms don't have output token
  let outputTokenAmount = BigInt.fromI32(0);

  // no input tokens received in this transaction, only reward tokens
  let inputTokenAmounts: TokenBalance[] = [];

  // number of reward tokens claimed by user in this transaction
  let rewardTokenAmounts: TokenBalance[] = [];
  getHarvestedRewards(event, market, rewardTokenAmounts);

  // total number of farm ownership tokens owned by user - 0 because sushi farms don't have token
  let outputTokenBalance = BigInt.fromI32(0);

  // inputTokenBalance -> number of LP tokens that can be redeemed by user
  let inputTokenBalances: TokenBalance[] = [];
  inputTokenBalances.push(new TokenBalance(sushiFarm.lpToken, userInfo.id, userInfo.amount));

  // reward token amounts (SUSHI + custom tokens) claimable by user
  let rewardTokenBalances: TokenBalance[] = [];
  collectRewardTokenBalances(sushiFarm, harvester, rewardTokenBalances, market);

  redeemFromMarket(
    event,
    harvester,
    market,
    outputTokenAmount,
    inputTokenAmounts,
    rewardTokenAmounts,
    outputTokenBalance,
    inputTokenBalances,
    rewardTokenBalances,
    null
  );
}

/**
 * Updates farm's supply of LP tokens, as well as farm reward parameters.
 * @param event
 */
export function handleLogUpdatePool(event: LogUpdatePool): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;

  // create farm snapshot
  let snapshotId = event.transaction.hash.toHexString() + "-" + event.logIndex.toHexString();
  let farmSnapshot = new SushiFarmSnapshot(snapshotId);
  farmSnapshot.sushiFarm = sushiFarm.id;
  farmSnapshot.allocPoint = sushiFarm.allocPoint;
  farmSnapshot.totalSupply = sushiFarm.totalSupply;
  farmSnapshot.timestamp = event.block.timestamp;
  farmSnapshot.transactionHash = event.transaction.hash.toHexString();
  farmSnapshot.transactionIndexInBlock = event.transaction.index;
  farmSnapshot.blockNumber = event.block.number;
  farmSnapshot.logIndex = event.logIndex;
  farmSnapshot.save();

  // update sushifarm
  sushiFarm.lastRewardBlock = event.params.lastRewardBlock;
  sushiFarm.totalSupply = event.params.lpSupply;
  sushiFarm.accSushiPerShare = event.params.accSushiPerShare;
  sushiFarm.save();

  // update market
  let masterChef = event.address.toHexString();
  let market = Market.load(masterChef + "-" + sushiFarm.id) as Market;
  updateMarket(
    event,
    market,
    [new TokenBalance(sushiFarm.lpToken, masterChef, sushiFarm.totalSupply)],
    BigInt.fromI32(0)
  );
}

/**
 * Event updates allocPoint and potentially the rewarder contract.
 * @param event
 */
export function handleLogSetPool(event: LogSetPool): void {
  let sushiFarm = SushiFarm.load(event.params.pid.toString()) as SushiFarm;

  // update sushifarm
  sushiFarm.allocPoint = event.params.allocPoint;
  if (event.params.overwrite) {
    sushiFarm.rewarder = event.params.rewarder.toHexString();
  }
  sushiFarm.save();
}

/**
 * Save reward token Transfer events, so they can be processed later as part of Harvest.
 * @param event
 */
export function handleRewardTokenTransfer(event: Transfer): void {
  let from = getOrCreateAccount(event.params.from);

  // if it is Sushi transfer and sender is MasterChef then store it as reward transfer
  let masterChef = MasterChef.load(from.id) as MasterChef;
  if (masterChef != null && event.address.toHexString() == masterChef.sushi) {
    let receiver = getOrCreateAccount(event.params.to);
    let transfer = new SushiRewardTransfer(event.transaction.hash.toHexString());
    transfer.from = from.id;
    transfer.to = receiver.id;
    transfer.value = event.params.value;
    transfer.transactionHash = event.transaction.hash.toHexString();
    transfer.save();
    return;
  }

  // if sender is Rewarder contract then it is extra token reward transfer
  let rewarder = Rewarder.load(from.id) as Rewarder;
  if (rewarder != null) {
    let receiver = getOrCreateAccount(event.params.to);

    let tx = event.transaction.hash.toHexString();
    let token = event.address.toHexString();

    let transfer = new ExtraRewardTokenTransfer(tx + "-" + token);
    transfer.rewardToken = token;
    transfer.from = from.id;
    transfer.to = receiver.id;
    transfer.value = event.params.value;
    transfer.transactionHash = tx;
    transfer.save();
    return;
  }
}

/**
 * Get reward tokens of a pool by fetching sushi token address and additionally fetch
 * extra reward tokens by calling `pendingTokens` function of rewarder contract.
 * Additionaly, start indexing extra reward tokens based on ERC20 template.
 * @param sushiFarm
 * @returns
 */
function getRewardTokens(sushiFarm: SushiFarm, event: ethereum.Event): Token[] {
  let tokens: Token[] = [];
  let masterChef = MasterChef.load(sushiFarm.masterChef);

  // add Sushi
  tokens.push(getOrCreateERC20Token(event, Address.fromString(masterChef.sushi)));

  // get extra reward tokens by querying Rewarder contract
  let rewarder = IRewarder.bind(Address.fromString(sushiFarm.rewarder));
  let result = rewarder.try_pendingTokens(
    BigInt.fromString(sushiFarm.id),
    Address.fromString(ADDRESS_ZERO),
    BigInt.fromI32(0)
  );
  if (!result.reverted) {
    let extraRewardTokens: Address[] = result.value.value0;
    for (let i: i32 = 0; i < extraRewardTokens.length; i++) {
      let tokenAddress = extraRewardTokens[i];
      let token = Token.load(tokenAddress.toHexString());
      if (token == null) {
        // start indexing transfer events
        RewardToken.create(tokenAddress);
      }

      tokens.push(getOrCreateERC20Token(event, tokenAddress));
    }
  }

  return tokens;
}

/**
 * Create UserInfo entity which tracks how many LP tokens user provided and how many Sushi rewards he claimed
 * @param user
 * @param farmPid
 * @returns
 */
function getOrCreateUserInfo(user: string, farmPid: string): UserInfo {
  let id = user + "-" + farmPid;
  let userInfo = UserInfo.load(id) as UserInfo;

  if (userInfo == null) {
    userInfo = new UserInfo(id);
    userInfo.amount = BigInt.fromI32(0);
    userInfo.rewardDebt = BigInt.fromI32(0);
    userInfo.user = user;
    userInfo.farm = farmPid;
    userInfo.save();
  }

  return userInfo;
}

/**
 * Get claimable reward token amounts. For Sushi calculate it, for other reward tokens use contract call
 * @param sushiFarm
 * @param receiver
 * @param rewardTokenBalances
 * @param market
 */
function collectRewardTokenBalances(
  sushiFarm: SushiFarm,
  account: Account,
  rewardTokenBalances: TokenBalance[],
  market: Market
): void {
  let rewardTokens = market.rewardTokens as string[];

  // calculate claimable amount of sushi
  let userInfo = UserInfo.load(account.id + "-" + sushiFarm.id);
  let claimableSushi = userInfo.amount
    .times(sushiFarm.accSushiPerShare)
    .div(ACC_SUSHI_PRECISION)
    .minus(userInfo.rewardDebt);
  rewardTokenBalances.push(new TokenBalance(rewardTokens[0], account.id, claimableSushi));

  // fetch claimable amount of extra reward tokens using rewarder contract call
  let rewarder = IRewarder.bind(Address.fromString(sushiFarm.rewarder));
  let result = rewarder.try_pendingTokens(
    BigInt.fromString(sushiFarm.id),
    Address.fromString(account.id),
    BigInt.fromI32(0)
  );
  if (!result.reverted) {
    let extraRewardTokens: Address[] = result.value.value0;
    let amounts: BigInt[] = result.value.value1;
    for (let i: i32 = 0; i < extraRewardTokens.length; i++) {
      // add claimable reward balance
      rewardTokenBalances.push(
        new TokenBalance(extraRewardTokens[i].toHexString(), account.id, amounts[i])
      );
    }
  }
}

/**
 * Get info about harvested Sushi and other reward tokens by looking at Transfer events which preceded
 * the Harvest event.
 * @param event
 * @param rewardTokenAmounts
 * @param rewardTokens
 * @param harvestedSushiAmount
 */
function getHarvestedRewards(
  event: ethereum.Event,
  market: Market,
  rewardTokenAmounts: TokenBalance[]
): void {
  let rewardTokens = market.rewardTokens as string[];

  // get sushi receiver (it doesn't have to be harvester himself) by checking preceding Sushi transfer
  let sushiEventEntityId = event.transaction.hash.toHexString();
  let sushiTransfer = SushiRewardTransfer.load(sushiEventEntityId);
  if (sushiTransfer != null) {
    let sushiReceiver = sushiTransfer.to;
    let sushiAmount = sushiTransfer.value;

    // store amount of harvested Sushi
    rewardTokenAmounts.push(new TokenBalance(rewardTokens[0], sushiReceiver, sushiAmount));
    // remove entity so that new one can be created in same transaction
    store.remove("SushiRewardTransfer", sushiEventEntityId);
  }

  // get and store extra token rewards, if any
  let tx = event.transaction.hash.toHexString();
  for (let i: i32 = 1; i < rewardTokens.length; i++) {
    let token = rewardTokens[i];
    let transfer = ExtraRewardTokenTransfer.load(tx + "-" + token);

    // if there was no reward token transfer preceding the Harvest event, don't handle it
    if (transfer == null) {
      continue;
    }

    let rewardReceiver = transfer.to;
    let rewardTokenAmount = transfer.value;
    rewardTokenAmounts.push(new TokenBalance(token, rewardReceiver, rewardTokenAmount));

    // remove entity so that new one can be created in same transaction for same token
    store.remove("ExtraRewardTokenTransfer", tx + "-" + token);
  }
}

/**
 * Function returns true if there's at least one reward transfer entity stored for current transaction.
 * If all reward transfers in this tx are already processed then there will be no stored entites (they
 * are deleted upon processing in withdraw or harvest) and function will return false.
 * @param market
 * @param event
 */
function isThereUnprocessedRewardTransfer(market: Market, event: Harvest): boolean {
  // check if there's unprocessed Sushi reward transfer
  let sushiEventEntityId = event.transaction.hash.toHexString();
  let sushiTransfer = SushiRewardTransfer.load(sushiEventEntityId);
  if (sushiTransfer != null) {
    return true;
  }

  // check if there's unprocessed extra reward token transfer
  let rewardTokens = market.rewardTokens as string[];
  let tx = event.transaction.hash.toHexString();
  for (let i: i32 = 1; i < rewardTokens.length; i++) {
    let token = rewardTokens[i];
    let transfer = ExtraRewardTokenTransfer.load(tx + "-" + token);

    // if there was no reward token transfer preceding the Harvest event, don't handle it
    if (transfer != null) {
      return true;
    }
  }

  return false;
}

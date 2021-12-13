import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";

import { CToken, UserDepositBalance } from "../../generated/schema";

import { CToken as CTokenContract } from "../../generated/templates/CToken/CToken";

import { getOrCreateERC20Token, getOrCreateMarketWithId } from "../library/common";

export function getOrCreateCToken(
  address: string,
  comptroller: string,
  event: ethereum.Event
): CToken {
  let cToken = CToken.load(address);
  if (cToken != null) {
    return cToken as CToken;
  }

  let cTokenContract = CTokenContract.bind(Address.fromString(address));
  let underlyingAsset = getOrCreateERC20Token(event, cTokenContract.underlying());

  cToken = new CToken(address);
  cToken.comptroller = comptroller;
  cToken.underlying = underlyingAsset.id;
  cToken.cTokenName = cTokenContract.name();
  cToken.cTokenSymbol = cTokenContract.symbol();
  cToken.cTokenDecimals = cTokenContract.decimals();
  cToken.transactionHash = event.transaction.hash.toHexString();
  cToken.save();

  return cToken as CToken;
}

export function getOrCreateUserDepositBalance(user: string, cToken: string): UserDepositBalance {
  let id = user + "-" + cToken;
  let userDepositBalance = UserDepositBalance.load(id);

  if (userDepositBalance != null) {
    return userDepositBalance as UserDepositBalance;
  }

  userDepositBalance = new UserDepositBalance(id);
  userDepositBalance.user = user;
  userDepositBalance.cToken = cToken;
  userDepositBalance.cTokenBalance = BigInt.fromI32(0);
  userDepositBalance.redeemableTokensBalance = BigInt.fromI32(0);
  userDepositBalance.save();

  return userDepositBalance as UserDepositBalance;
}

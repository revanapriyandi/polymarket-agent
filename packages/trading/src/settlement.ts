import { createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hash } from 'viem';
import { polygon } from 'viem/chains';
import { D } from './math';
import { GatewayError } from './errors';

// ABI verified against Polymarket/ctf-exchange-v2 Events.sol; fee is collateral e6.
const events=parseAbi(['event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)']);
export async function readOrderSettlement(rpcUrl:string, transactionHash:Hash, orderHash:Hash, exchange:Address, wallet:Address) {
  const rpc=createPublicClient({chain:polygon,transport:http(rpcUrl)});
  const receipt=await rpc.getTransactionReceipt({hash:transactionHash});
  if(receipt.status!=='success') throw new GatewayError('SETTLEMENT_REVERTED','Order settlement transaction reverted');
  const head=await rpc.getBlockNumber();
  const fills=[];
  for(const log of receipt.logs) {
    if(log.address.toLowerCase()!==exchange.toLowerCase()) continue;
    let event;
    try { event=decodeEventLog({abi:events,data:log.data,topics:log.topics}); } catch {continue;}
    const args=event.args;
    if(args.orderHash.toLowerCase()!==orderHash.toLowerCase() || args.maker.toLowerCase()!==wallet.toLowerCase()) continue;
    const shares=args.side===0 ? args.takerAmountFilled : args.makerAmountFilled;
    const cash=args.side===0 ? args.makerAmountFilled : args.takerAmountFilled;
    fills.push({transactionHash,logIndex:log.logIndex,orderId:args.orderHash,tokenId:args.tokenId.toString(),side:args.side===0?'BUY':'SELL',shares:D(shares.toString()).div(1000000).toFixed(),notionalUsd:D(cash.toString()).div(1000000).toFixed(),actualFeeUsd:D(args.fee.toString()).div(1000000).toFixed()});
  }
  return {transactionHash,blockNumber:receipt.blockNumber.toString(),confirmations:(head-receipt.blockNumber+1n).toString(),fills};
}

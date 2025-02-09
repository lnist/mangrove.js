import * as ethers from "ethers";

import Market from "../../market";
// syntactic sugar
import Mangrove from "../../mangrove";

import PrettyPrint, { prettyPrintFilter } from "../prettyPrint";
import { LiquidityProvider } from "../..";
import * as typechain from "../../types/typechain";
import { waitForTransaction } from "./mgvIntegrationTestUtil";
import { node } from "../../util/node";
import { Log } from "@ethersproject/providers";

/** Usage example
  Terminal 1: 
  $ npx mgv node
 
  Terminal 2:
  $ ts-node --skipProject
  > import {Mangrove,TestMaker} from './src'
  > const mgv = await Mangrove.connect(); // localhost:8545 by default
  > const tm = await TestMaker.create({mgv,base:"TokenA",quote:"TokenB"});
  > await tm.newOffer({ba:"asks",wants:1,gives:1,shouldRevert:true});
  > // We posted an offer.
  > // * Notice the shouldRevert:true
  > // * The base token must be mintable
  >
  > // We're done. To test that the offer does fail:
  > await tm.market.requestBook() // show the current book
  > const quote = tm.market.quote;
  > await quote.approveMangrove();
  > await quote.contract.mintTo(await mgv.signer.getAddress(),quote.toUnits(10));
  > // will contain a revert
  > const {result,response} = await tm.market.buy({volume:2,price:1});
*/
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace TestMaker {
  export type OfferParams = LiquidityProvider.OfferParams & {
    shouldRevert?: boolean;
    executeData?: string;
    gasreq?: number;
    gasprice?: number;
  };

  export type CreateParams = {
    mgv: Mangrove;
    base: string;
    quote: string;
  };
}

/* Prevent directly calling Mangrove constructor
   use Mangrove.connect to make sure the network is reached during construction */
let canConstructTestMaker = false;

const PROVISION_AMOUNT_IN_ETHERS = 2;

class TestMaker {
  mgv: Mangrove;
  contract: typechain.SimpleTestMaker;
  market: Market;
  prettyP = new PrettyPrint();

  constructor(p: { mgv: Mangrove; market: Market; address: string }) {
    if (!canConstructTestMaker) {
      throw Error(
        "TestMaker must be initialized async with Market.create (constructors cannot be async)"
      );
    }
    this.mgv = p.mgv;
    this.contract = typechain.SimpleTestMaker__factory.connect(
      p.address,
      p.mgv.signer
    );
    this.market = p.market;
  }

  static async create(
    p: TestMaker.CreateParams & Partial<Market.OptionalParams>
  ): Promise<TestMaker> {
    const baseAddress = p.mgv.getAddress(p.base);
    const quoteAddress = p.mgv.getAddress(p.quote);
    const contract = await new typechain.SimpleTestMaker__factory(
      p.mgv.signer
    ).deploy(p.mgv.address, baseAddress, quoteAddress);
    await contract.deployTransaction.wait();

    const amount = Mangrove.toUnits(PROVISION_AMOUNT_IN_ETHERS, 18);
    const tx = await contract.provisionMgv(amount, { value: amount });
    await tx.wait();

    const market = await Market.connect(p);

    canConstructTestMaker = true;
    const testMaker = new TestMaker({
      mgv: p.mgv,
      market,
      address: contract.address,
    });
    canConstructTestMaker = false;
    return testMaker;
  }

  async approveMgv(address: string) {
    return waitForTransaction(
      this.contract.approveMgv(address, ethers.constants.MaxUint256, {
        gasLimit: 100_000,
      })
    );
  }

  async newOffer(
    p: { ba: Market.BA } & TestMaker.OfferParams,
    overrides: ethers.Overrides = {}
  ) {
    const defaults = {
      shouldRevert: false,
      executeData: "executeData",
      gasreq: 100_000,
      gasprice: 0,
    };

    p = { ...defaults, ...p };

    const { wants, gives, price, fund } =
      LiquidityProvider.normalizeOfferParams(p);

    const { outbound_tkn, inbound_tkn } = this.market.getOutboundInbound(p.ba);

    // ensure mangrove is approved
    await this.approveMgv(outbound_tkn.address);
    await this.approveMgv(inbound_tkn.address);

    if (!(this.mgv.provider instanceof ethers.providers.JsonRpcProvider)) {
      throw new Error("TestMaker requires a JsonRpcProvider");
    }
    const url = this.mgv.provider.connection.url;

    // Ensure maker has the right amount of tokens
    const internalBal = await outbound_tkn.contract.balanceOf(
      this.contract.address
    );
    await (
      await (
        await node({ url: url, spawn: false, deploy: false, script: "" })
      ).connect()
    ).deal({
      token: outbound_tkn.address,
      account: this.contract.address,
      internalAmount: internalBal.add(outbound_tkn.toUnits(gives)),
    });

    const payableOverrides = LiquidityProvider.optValueToPayableOverride(
      overrides,
      fund
    );

    const amount = payableOverrides.value ?? 0;

    const offerData = {
      shouldRevert: p.shouldRevert as boolean,
      executeData: p.executeData as string,
    };

    const pivot = (await this.market.getPivotId(p.ba, price)) ?? 0;

    const txPromise = this.contract[
      "newOfferWithFunding(address,address,uint256,uint256,uint256,uint256,uint256,uint256,(bool,string))"
    ](
      this.market.base.address,
      this.market.quote.address,
      inbound_tkn.toUnits(wants),
      outbound_tkn.toUnits(gives),
      p.gasreq as number,
      p.gasprice as number,
      pivot,
      amount,
      offerData,
      payableOverrides
    );

    return this.#constructPromise(
      this.market,
      (_cbArg, _bookEevnt, _ethersLog) => ({
        id: _cbArg.offerId as number,
        pivot: pivot,
        event: _ethersLog as Log,
      }),
      txPromise,
      (cbArg) => cbArg.type === "OfferWrite"
    );
  }

  #constructPromise<T>(
    market: Market,
    cb: Market.MarketCallback<T>,
    txPromise: Promise<ethers.ethers.ContractTransaction>,
    filter: Market.MarketFilter
  ): Promise<T> {
    let promiseResolve: (value: T) => void;
    let promiseReject: (reason: string) => void;
    const promise = new Promise<T>((resolve, reject) => {
      promiseResolve = resolve;
      promiseReject = reject;
    });

    // catch rejections of the txPromise and reject returned promise
    txPromise.catch((e) => promiseReject(e));

    const callback = async (
      cbArg: Market.BookSubscriptionCbArgument,
      bookEvent?: Market.BookSubscriptionEvent,
      ethersLog?: ethers.providers.Log
    ) => {
      const txHash = (await txPromise).hash;
      const logTxHash = ethersLog?.transactionHash;
      if (txHash === logTxHash && filter(cbArg)) {
        promiseResolve(await cb(cbArg, bookEvent, ethersLog));
      }
    };

    market.subscribe(callback); // TODO: subscribe/once ?

    return promise.finally(() => market.unsubscribe(callback));
  }

  /** Post a new ask */
  newAsk(p: TestMaker.OfferParams, overrides: ethers.Overrides = {}) {
    return this.newOffer({ ba: "asks", ...p }, overrides);
  }

  /** Post a new bid */
  newBid(p: TestMaker.OfferParams, overrides: ethers.Overrides = {}) {
    return this.newOffer({ ba: "bids", ...p }, overrides);
  }

  /** List all of the maker's asks in the cache */
  asks(): Market.Offer[] {
    return this.market
      .getBook()
      .asks.iter()
      .filter((ofr) => ofr.maker === this.contract.address)
      .toArray();
  }

  /** List all of the maker's bids in the cache */
  bids(): Market.Offer[] {
    return this.market
      .getBook()
      .bids.iter()
      .filter((ofr) => ofr.maker === this.contract.address)
      .toArray();
  }

  /** Pretty prints the current state of the asks for the maker */
  consoleAsks(filter?: prettyPrintFilter): void {
    this.prettyP.consoleOffers(this.asks(), filter);
  }

  /** Pretty prints the current state of the bids for the maker */
  consoleBids(filter?: prettyPrintFilter): void {
    this.prettyP.consoleOffers(this.bids(), filter);
  }
}

export default TestMaker;

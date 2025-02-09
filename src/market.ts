import * as ethers from "ethers";
import { BigNumber } from "ethers"; // syntactic sugar
import Mangrove from "./mangrove";
import MgvToken from "./mgvtoken";
import Semibook from "./semibook";
import { Bigish, typechain } from "./types";
import Trade from "./util/trade";

let canConstructMarket = false;

const MAX_MARKET_ORDER_GAS = 10000000;

/* Note on big.js:
ethers.js's BigNumber (actually BN.js) only handles integers
big.js handles arbitrary precision decimals, which is what we want
for more on big.js vs decimals.js vs. bignumber.js (which is *not* ethers's BigNumber):
  github.com/MikeMcl/big.js/issues/45#issuecomment-104211175
*/
import Big from "big.js";

export const bookOptsDefault: Market.BookOptions = {
  maxOffers: Semibook.DEFAULT_MAX_OFFERS,
};

import * as TCM from "./types/typechain/Mangrove";
import TradeEventManagement from "./util/tradeEventManagement";
import PrettyPrint, { prettyPrintFilter } from "./util/prettyPrint";

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Market {
  export type BA = "bids" | "asks";
  export type BS = "buy" | "sell";
  export type MgvReader = typechain.MgvReader;
  export type Failure = {
    offerId: number;
    reason: string;
    FailToDeliver?: Big;
    volumeGiven?: Big;
  };
  export type Success = {
    offerId: number;
    got: Big;
    gave: Big;
  };
  export type Summary = {
    got: Big;
    gave: Big;
    partialFill: boolean;
    bounty: Big;
    feePaid: Big;
  };
  export type OrderResult = {
    txReceipt: ethers.ContractReceipt;
    summary: Summary;
    successes: Success[];
    tradeFailures: Failure[];
    posthookFailures: Failure[];
    offerWrites: { ba: Market.BA; offer: Market.OfferSlim }[];
    restingOrder?: Market.OfferSlim;
  };

  export type BookSubscriptionEvent =
    | ({ name: "OfferWrite" } & TCM.OfferWriteEvent)
    | ({ name: "OfferFail" } & TCM.OfferFailEvent)
    | ({ name: "OfferSuccess" } & TCM.OfferSuccessEvent)
    | ({ name: "OfferRetract" } & TCM.OfferRetractEvent)
    | ({ name: "SetGasbase" } & TCM.SetGasbaseEvent);

  export type OrderRoute = "Mangrove" | "MangroveOrder";

  export type TradeParams = {
    forceRoutingToMangroveOrder?: boolean;
    slippage?: number;
    fillOrKill?: boolean;
    expiryDate?: number;
    gasLowerBound?: ethers.ethers.BigNumberish;
  } & ({ restingOrder?: RestingOrderParams } | { offerId?: number }) &
    (
      | { volume: Bigish; price: Bigish }
      | { total: Bigish; price: Bigish }
      | { wants: Bigish; gives: Bigish; fillWants?: boolean }
    );

  export type RestingOrderParams = {
    provision: Bigish;
  };

  export type SnipeParams = {
    targets: {
      offerId: number;
      takerWants: Bigish;
      takerGives: Bigish;
      gasLimit?: number;
    }[];
    ba: Market.BA;
    fillWants?: boolean;
    requireOffersToFail?: boolean;
  };

  export type RawSnipeParams = {
    ba: Market.BA;
    outboundTkn: string;
    inboundTkn: string;
    targets: [
      Promise<ethers.ethers.BigNumberish> | ethers.ethers.BigNumberish,
      Promise<ethers.ethers.BigNumberish> | ethers.ethers.BigNumberish,
      Promise<ethers.ethers.BigNumberish> | ethers.ethers.BigNumberish,
      Promise<ethers.ethers.BigNumberish> | ethers.ethers.BigNumberish
    ][];
    fillWants: boolean;
  };

  /**
   * Specification of how much volume to (potentially) trade on the market.
   *
   * `{given:100, what:"base", to:"buy"}` means buying 100 base tokens.
   *
   * `{given:10, what:"quote", to:"sell"})` means selling 10 quote tokens.
   */
  export type VolumeParams = Semibook.VolumeParams & {
    /** Whether `given` is the market's base or quote. */
    what: "base" | "quote";
  };
  export type DirectionlessVolumeParams = Omit<VolumeParams, "to">;

  export type OptionalParams = {
    bookOptions: Market.BookOptions;
    noInit: boolean;
  };

  /**
   * Options that specify what the cache fetches and retains.
   *
   * `maxOffers`, `desiredPrice`, and `desiredVolume` are mutually exclusive.
   * If none of these are specified, the default is `maxOffers` = `Semibook.DEFAULT_MAX_OFFERS`.
   */
  export type CacheContentsOptions =
    | {
        /** The maximum number of offers to store in the cache.
         *
         * `maxOffers, `desiredPrice`, and `desiredVolume` are mutually exclusive.
         */
        maxOffers?: number;
      }
    | {
        /** The price that is expected to be used in calls to the market.
         * The cache will initially contain all offers with this price or better.
         * This can be useful in order to ensure a good pivot is readily available.
         */
        desiredPrice: Bigish;
      }
    | {
        /**
         * The volume that is expected to be used in trades on the market.
         */
        desiredVolume: VolumeParams;
      };

  /**
   * Options that control how the book cache behaves.
   */
  export type BookOptions = CacheContentsOptions & {
    /** The number of offers to fetch in one call.
     *
     * Defaults to `maxOffers` if it is set and positive; Otherwise `Semibook.DEFAULT_MAX_OFFERS` is used. */
    chunkSize?: number;
  };

  export type OfferSlim = {
    id: number;
    prev: number | undefined;
    gasprice: number;
    maker: string;
    gasreq: number;
    wants: Big;
    gives: Big;
    volume: Big;
    price: Big | undefined;
  };

  export type Offer = OfferSlim & {
    next: number | undefined;
    offer_gasbase: number;
  };

  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace BookReturns {
    type _BookReturns = Awaited<
      ReturnType<Market.MgvReader["functions"]["offerList"]>
    >;
    export type Indices = _BookReturns[1];
    export type Offers = _BookReturns[2];
    export type Details = _BookReturns[3];
  }

  export type BookSubscriptionCbArgument = {
    ba: Market.BA;
    offerId?: number;
    offer?: Offer; // if undefined, offer was not found/inserted in local cache
  } & (
    | { type: "OfferWrite" }
    | {
        type: "OfferFail";
        taker: string;
        takerWants: Big;
        takerGives: Big;
        mgvData: string;
      }
    | { type: "OfferSuccess"; taker: string; takerWants: Big; takerGives: Big }
    | { type: "OfferRetract" }
    | { type: "SetGasbase" }
  );

  export type MarketCallback<T> = (
    cbArg: BookSubscriptionCbArgument,
    event?: BookSubscriptionEvent,
    ethersLog?: ethers.providers.Log
  ) => T | Promise<T>;
  export type StorableMarketCallback = MarketCallback<any>;
  export type MarketFilter = MarketCallback<boolean>;
  export type SubscriptionParam =
    | { type: "multiple" }
    | {
        type: "once";
        ok: (...a: any[]) => any;
        ko: (...a: any[]) => any;
        filter?: (...a: any[]) => boolean | Promise<boolean>;
      };

  export type Book = { asks: Semibook; bids: Semibook };

  export type VolumeEstimate = {
    estimatedVolume: Big;
    givenResidue: Big;
  };
}
// no unsubscribe yet
/**
 * The Market class focuses on a Mangrove market.
 * On-chain, markets are implemented as two offer lists,
 * one for asks (base,quote), the other for bids (quote,base).
 *
 * Market initialization needs to store the network name, so you cannot
 * directly use the constructor. Instead of `new Market(...)`, do
 *
 * `await Market.connect(...)`
 */
class Market {
  mgv: Mangrove;
  base: MgvToken;
  quote: MgvToken;
  #subscriptions: Map<Market.StorableMarketCallback, Market.SubscriptionParam>;
  #asksSemibook: Semibook | undefined;
  #bidsSemibook: Semibook | undefined;
  #initClosure?: () => Promise<void>;
  trade: Trade = new Trade();
  tradeEventManagement: TradeEventManagement = new TradeEventManagement();
  prettyP = new PrettyPrint();

  private asksCb: Semibook.EventListener | undefined;
  private bidsCb: Semibook.EventListener | undefined;

  static async connect(
    params: {
      mgv: Mangrove;
      base: string;
      quote: string;
    } & Partial<Market.OptionalParams>
  ): Promise<Market> {
    canConstructMarket = true;
    const market = new Market(params);
    canConstructMarket = false;
    if (params["noInit"]) {
      market.#initClosure = () => {
        return market.#initialize(params.bookOptions);
      };
    } else {
      await market.#initialize(params.bookOptions);
    }

    return market;
  }

  /**
   * Initialize a new `params.base`:`params.quote` market.
   *
   * `params.mgv` will be used as mangrove instance
   */
  private constructor(params: { mgv: Mangrove; base: string; quote: string }) {
    if (!canConstructMarket) {
      throw Error(
        "Mangrove Market must be initialized async with Market.connect (constructors cannot be async)"
      );
    }
    this.#subscriptions = new Map();

    this.mgv = params.mgv;

    this.base = this.mgv.token(params.base);
    this.quote = this.mgv.token(params.quote);
  }

  public close() {
    if (
      !this.asksCb ||
      !this.bidsCb ||
      !this.#asksSemibook ||
      !this.#bidsSemibook
    ) {
      throw Error("Market is not initialized");
    }
    this.#asksSemibook.removeEventListener(this.asksCb);
    this.#bidsSemibook.removeEventListener(this.bidsCb);
  }

  initialize(): Promise<void> {
    if (typeof this.#initClosure === "undefined") {
      throw new Error("Cannot initialize already initialized market.");
    } else {
      const initClosure = this.#initClosure;
      this.#initClosure = undefined;
      return initClosure();
    }
  }

  async #initialize(opts: Market.BookOptions = bookOptsDefault): Promise<void> {
    const semibookDesiredVolume =
      "desiredVolume" in opts && opts.desiredVolume !== undefined
        ? { given: opts.desiredVolume.given, to: opts.desiredVolume.to }
        : undefined;

    const getSemibookOpts: (ba: Market.BA) => Semibook.Options = (ba) => {
      if (
        (ba === "asks" && Semibook.getIsVolumeDesiredForAsks(opts)) ||
        (ba === "bids" && Semibook.getIsVolumeDesiredForBids(opts))
      ) {
        return {
          desiredVolume: semibookDesiredVolume,
          chunkSize: opts.chunkSize,
        };
      } else if ("desiredPrice" in opts) {
        return {
          desiredPrice: opts.desiredPrice,
          chunkSize: opts.chunkSize,
        };
      } else if ("maxOffers" in opts) {
        return {
          maxOffers: opts.maxOffers,
          chunkSize: opts.chunkSize,
        };
      } else {
        return {
          chunkSize: opts.chunkSize,
        };
      }
    };

    this.asksCb = this.#semibookEventCallback.bind(this);
    const asksPromise = Semibook.connect(
      this,
      "asks",
      this.asksCb,
      getSemibookOpts("asks")
    );
    this.bidsCb = this.#semibookEventCallback.bind(this);
    const bidsPromise = Semibook.connect(
      this,
      "bids",
      this.bidsCb,
      getSemibookOpts("bids")
    );
    this.#asksSemibook = await asksPromise;
    this.#bidsSemibook = await bidsPromise;
  }

  async #semibookEventCallback({
    cbArg,
    event,
    ethersLog: ethersLog,
  }: Semibook.Event): Promise<void> {
    for (const [cb, params] of this.#subscriptions) {
      if (params.type === "once") {
        let isFilterSatisfied: boolean;
        if (!("filter" in params) || params.filter === undefined) {
          isFilterSatisfied = true;
        } else {
          const filterResult = params.filter(cbArg, event, ethersLog);
          isFilterSatisfied =
            typeof filterResult === "boolean"
              ? filterResult
              : await filterResult;
        }
        if (isFilterSatisfied) {
          this.#subscriptions.delete(cb);
          Promise.resolve(cb(cbArg, event, ethersLog)).then(
            params.ok,
            params.ko
          );
        }
      } else {
        cb(cbArg, event, ethersLog);
      }
    }
  }

  /**
   * Return the semibooks of this market.
   *
   * Asks are standing offers to sell base and buy quote.
   * Bids are standing offers to buy base and sell quote.
   * All prices are in quote/base, all volumes are in base.
   * Order is from best to worse from taker perspective.
   */
  getBook(): Market.Book {
    if (!this.#asksSemibook || !this.#bidsSemibook) {
      throw Error("Market is not initialized");
    }
    return {
      asks: this.#asksSemibook,
      bids: this.#bidsSemibook,
    };
  }

  /**
   * Return the asks or bids semibook
   */
  getSemibook(ba: Market.BA): Semibook {
    if (!this.#asksSemibook || !this.#bidsSemibook) {
      throw Error("Market is not initialized");
    }
    return ba === "asks" ? this.#asksSemibook : this.#bidsSemibook;
  }

  async requestBook(
    opts: Market.BookOptions = bookOptsDefault
  ): Promise<{ asks: Market.Offer[]; bids: Market.Offer[] }> {
    if (!this.#asksSemibook || !this.#bidsSemibook) {
      throw Error("Market is not initialized");
    }
    const asksPromise = this.#asksSemibook.requestOfferListPrefix(opts);
    const bidsPromise = this.#bidsSemibook.requestOfferListPrefix(opts);
    return {
      asks: await asksPromise,
      bids: await bidsPromise,
    };
  }

  async isActive(): Promise<boolean> {
    const config = await this.config();
    return config.asks.active && config.bids.active;
  }

  async isLive(ba: Market.BA, offerId: number): Promise<boolean> {
    const offer: Market.Offer = await this.getSemibook(ba).offerInfo(offerId);
    return this.isLiveOffer(offer);
  }

  isLiveOffer(offer: Market.Offer): boolean {
    if (!offer.gives.gt) {
      console.log(offer);
    }
    return offer.gives.gt(0);
  }

  /** Given a price, find the id of the immediately-better offer in the
   * book. If there is no offer with a better price, `undefined` is returned.
   */
  async getPivotId(
    ba: Market.BA,
    price: Bigish | undefined
  ): Promise<number | undefined> {
    return this.getSemibook(ba).getPivotId(price);
  }

  /** Gets the amount of ethers necessary to provision an offer on the market.
   * @param ba bids or asks
   * @param gasreq gas required for the offer execution.
   * @param gasprice gas price to use for the calculation. If undefined, then Mangrove's current gas price is used.
   * @returns the amount of ethers necessary to provision the offer.
   */
  async getOfferProvision(
    ba: Market.BA,
    gasreq: number,
    gasprice?: number
  ): Promise<Big> {
    // 0 makes calculation use mgv gasprice
    gasprice ??= 0;
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);
    const prov = await this.mgv.readerContract[
      "getProvision(address,address,uint256,uint256)"
    ](outbound_tkn.address, inbound_tkn.address, gasreq, gasprice);
    return this.mgv.fromUnits(prov, 18);
  }

  /** Gets the amount of ethers necessary to provision a bid on the market.
   * @param gasreq gas required for the offer execution.
   * @param gasprice gas price to use for the calculation. If undefined, then Mangrove's current gas price is used.
   * @returns the amount of ethers necessary to provision the offer.
   */
  getBidProvision(gasreq: number, gasprice?: number): Promise<Big> {
    return this.getOfferProvision("bids", gasreq, gasprice);
  }

  /** Gets the amount of ethers necessary to provision a bid on the market.
   * @param gasreq gas required for the offer execution.
   * @param gasprice gas price to use for the calculation. If undefined, then Mangrove's current gas price is used.
   * @returns the amount of ethers necessary to provision the offer.
   */
  getAskProvision(gasreq: number, gasprice?: number): Promise<Big> {
    return this.getOfferProvision("asks", gasreq, gasprice);
  }

  /** Gets the missing provision in ethers for an offer with the given parameters
   * @param ba bids or asks
   * @param lockedProvision the provision already locked with the offer
   * @param gasreq gas required for the offer execution.
   * @param gasprice gas price to use for the calculation. If undefined, then Mangrove's current gas price is used.
   * @returns the additional required provision, in ethers.
   */
  async getMissingProvision(
    ba: Market.BA,
    lockedProvision: Bigish,
    gasreq: number,
    gasprice?: number
  ) {
    const totalRequiredProvision = await this.getOfferProvision(
      ba,
      gasreq,
      gasprice
    );
    return this.mgv.getMissingProvision(
      lockedProvision,
      totalRequiredProvision
    );
  }

  bidInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("bids", offerId);
  }

  askInfo(offerId: number): Promise<Market.Offer> {
    return this.offerInfo("asks", offerId);
  }

  /** Returns struct containing offer details in the current market */
  async offerInfo(ba: Market.BA, offerId: number): Promise<Market.Offer> {
    return this.getSemibook(ba).offerInfo(offerId);
  }

  /** Sign permit data. If action="buy", will permit buying base with spender's
   * quote token. If action="sell", will permit buying quote with spender's base
   * token. See mangrove.ts. */
  permit(
    action: "buy" | "sell",
    data: Omit<Mangrove.SimplePermitData, "outbound_tkn" | "inbound_tkn">
  ): Promise<ethers.ContractTransaction> {
    let outbound_tkn: MgvToken;
    let inbound_tkn: MgvToken;

    if (action === "buy") {
      outbound_tkn = this.base;
      inbound_tkn = this.quote;
    } else {
      outbound_tkn = this.quote;
      inbound_tkn = this.base;
    }

    return this.mgv.permit({
      ...data,
      outbound_tkn: outbound_tkn.address,
      inbound_tkn: inbound_tkn.address,
    });
  }

  /**
   * Market buy order. Will attempt to buy base token using quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: buy `volume` base tokens for a max average price of `price`.
   * - `{total,price}` : buy as many base tokens as possible using up to `total` quote tokens, with a max average price of `price`.
   * - `{wants,gives,fillWants?}`: accept implicit max average price of `gives/wants`
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token, and
   * `restingOrder` or `offerId` can be supplied to create a resting order or to snipe a specific order, e.g.,
   * to account for gas.
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * - `wants` tokens have been bought.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"};
   * market.buy({volume: 100, price: '1.01'}) //use strings to be exact
   * ```
   */
  buy(
    params: Market.TradeParams,
    overrides: ethers.Overrides = {}
  ): Promise<{
    result: Promise<Market.OrderResult>;
    response: Promise<ethers.ContractTransaction>;
  }> {
    return this.trade.order("buy", params, this, overrides);
  }

  /**
   * Market sell order. Will attempt to sell base token for quote tokens.
   * Params can be of the form:
   * - `{volume,price}`: sell `volume` base tokens for a min average price of `price`.
   * - `{total,price}` : sell as many base tokens as possible buying up to `total` quote tokens, with a min average price of `price`.
   * - `{wants,gives,fillWants?}`: accept implicit min average price of `gives/wants`. `fillWants` will be false by default.
   *
   * In addition, `slippage` defines an allowed slippage in % of the amount of quote token, and
   * `restingOrder` or `offerId` can be supplied to create a resting order or to snipe a specific order, e.g.,
   * to account for gas.
   *
   * Will stop if
   * - book is empty, or
   * - price no longer good, or
   * -`gives` tokens have been sold.
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"})
   * market.sell({volume: 100, price: 1})
   * ```
   */
  sell(
    params: Market.TradeParams,
    overrides: ethers.Overrides = {}
  ): Promise<{
    result: Promise<Market.OrderResult>;
    response: Promise<ethers.ContractTransaction>;
  }> {
    return this.trade.order("sell", params, this, overrides);
  }

  /** Estimate amount of gas for buy. Can be passed as overrides.gasLimit or params.gasLowerBound of @see buy with same params. */
  gasEstimateBuy(params: Market.TradeParams): Promise<BigNumber> {
    return this.trade
      .estimateGas("buy", params, this)
      .then((v) => v ?? BigNumber.from(0));
  }

  /** Estimate amount of gas for sell. Can be passed as overrides.gasLimit or params.gasLowerBound of @see sell with same params. */
  gasEstimateSell(params: Market.TradeParams): Promise<BigNumber> {
    return this.trade
      .estimateGas("sell", params, this)
      .then((v) => v ?? BigNumber.from(0));
  }

  /**
   * Snipe specific offers.
   * Params are:
   * `targets`: an array of
   *    `offerId`: the offer to snipe
   *    `takerWants`: the amount of base token (for asks) or quote token (for bids) the taker wants
   *    `takerGives`: the amount of quote token (for asks) or base token (for bids) the take gives
   *    `gasLimit?`: the maximum gas requirement the taker will tolerate for that offer
   * `ba`: whether to snipe `asks` or `bids`
   * `fillWants?`: specifies whether you will buy at most `takerWants` (true), or you will buy as many tokens as possible as long as you don't spend more than `takerGives` (false).
   * `requireOffersToFail`: if true, then a successful offer will cause the call to fail without sniping anything.
   *     Note: Setting `requireOffersToFail=true` uses the cleaner contract and the taker needs to approve spending, with
   *     `await mgv.contract.approve(market.base.address, market.quote.address, mgv.cleanerContract.address, amount);`
   */
  snipe(
    params: Market.SnipeParams,
    overrides: ethers.Overrides = {}
  ): Promise<{
    result: Promise<Market.OrderResult>;
    response: Promise<ethers.ContractTransaction>;
  }> {
    return this.trade.snipe(params, this, overrides);
  }

  /**
   * Gets parameters to send to functions `market.mgv.cleanerContract.collect` or `market.mgv.contract.snipes`.
   * Params are:
   * `targets`: an array of
   *    `offerId`: the offer to snipe
   *    `takerWants`: the amount of base token (for asks) or quote token (for bids) the taker wants
   *    `takerGives`: the amount of quote token (for asks) or base token (for bids) the take gives
   *    `gasLimit?`: the maximum gas requirement the taker will tolerate for that offer
   * `ba`: whether to snipe `asks` or `bids`
   * `fillWants?`: specifies whether you will buy at most `takerWants` (true), or you will buy as many tokens as possible as long as you don't spend more than `takerGives` (false).
   * `requireOffersToFail`: defines whether a successful offer will cause the call to fail without sniping anything.
   */
  getRawSnipeParams(
    params: Market.SnipeParams,
    overrides: ethers.Overrides = {}
  ): Promise<Market.RawSnipeParams> {
    return this.trade.getRawSnipeParams(params, this, overrides);
  }

  async estimateGas(bs: Market.BS, volume: BigNumber): Promise<BigNumber> {
    const semibook = this.getSemibook(this.trade.bsToBa(bs));
    const {
      local: { density, offer_gasbase },
    } = await semibook.getRawConfig();

    const maxGasreqOffer = (await semibook.getMaxGasReq()) ?? 0;
    const maxMarketOrderGas: BigNumber = BigNumber.from(MAX_MARKET_ORDER_GAS);
    // boosting estimates of 10% to be on the safe side
    const estimation = density.isZero()
      ? maxMarketOrderGas
      : offer_gasbase
          .add(volume.div(density))
          .add(maxGasreqOffer)
          .add(BigNumber.from(maxGasreqOffer).mul(64).div(63))
          .mul(11)
          .div(10);

    if (estimation.lt(maxMarketOrderGas)) return estimation;

    return maxMarketOrderGas;
  }

  /** Uses the @see semibook.simulateMarketOrder to simulate the gas required for a market order. An overhead of 50% is added to account for changes to the book and failing offers.
   * @param ba: bids or asks
   * @param gives: amount of inbound token to give to the makers
   * @param wants: amount of outbound token to receive from the makers
   * @param fillWants: whether to fill wants or gives
   */
  async simulateGas(
    ba: Market.BA,
    gives: BigNumber,
    wants: BigNumber,
    fillWants: boolean
  ): Promise<BigNumber> {
    const semibook = this.getSemibook(ba);
    const { outbound_tkn, inbound_tkn } = this.getOutboundInbound(ba);

    // Overestimate by 50% because market can have changed between estimation and execution and some offers may be failing.
    const estimation = (
      await semibook.simulateMarketOrder(
        outbound_tkn.fromUnits(wants),
        inbound_tkn.fromUnits(gives),
        fillWants
      )
    ).gas
      .mul(15)
      .div(10);

    const maxMarketOrderGas: BigNumber = BigNumber.from(MAX_MARKET_ORDER_GAS);

    if (estimation.lt(maxMarketOrderGas)) return estimation;

    return maxMarketOrderGas;
  }

  /**
   * Volume estimator.
   *
   * if you say `estimateVolume({given:100,what:"base",to:"buy"})`,
   *
   * it will give you an estimate of how much quote token you would have to
   * spend to get 100 base tokens.
   *
   * if you say `estimateVolume({given:10,what:"quote",to:"sell"})`,
   *
   * it will given you an estimate of how much base tokens you'd have to buy in
   * order to spend 10 quote tokens.
   * */
  async estimateVolume(
    params: Market.VolumeParams
  ): Promise<Market.VolumeEstimate> {
    if (
      (params.what === "base" && params.to === "buy") ||
      (params.what === "quote" && params.to === "sell")
    ) {
      return await this.getSemibook("asks").estimateVolume(params);
    } else {
      return await this.getSemibook("bids").estimateVolume(params);
    }
  }

  /* Convenience method: estimate volume to be received given an amount of base/quote you are ready to spend. */
  async estimateVolumeToReceive(
    params: Market.DirectionlessVolumeParams
  ): Promise<Market.VolumeEstimate> {
    return this.estimateVolume({ ...params, to: "sell" });
  }

  /* Convenience method: estimate volume to be spent given an amount of base/quote you want to receive. */
  async estimateVolumeToSpend(
    params: Market.DirectionlessVolumeParams
  ): Promise<Market.VolumeEstimate> {
    return this.estimateVolume({ ...params, to: "buy" });
  }

  /* Convenience method to estimate volume */

  /**
   * Return config local to a market.
   * Returned object is of the form
   * `{bids,asks}` where bids and asks are of type `localConfig`
   * Notes:
   * Amounts are converted to plain numbers.
   * density is converted to public token units per gas used
   * fee *remains* in basis points of the token being bought
   */
  async config(): Promise<{
    asks: Mangrove.LocalConfig;
    bids: Mangrove.LocalConfig;
  }> {
    const asksConfigPromise = this.getSemibook("asks").getConfig();
    const bidsConfigPromise = this.getSemibook("bids").getConfig();
    return {
      asks: await asksConfigPromise,
      bids: await bidsConfigPromise,
    };
  }

  /** Pretty prints the current state of the asks of the market */
  consoleAsks(filter?: prettyPrintFilter): void {
    this.prettyP.consoleOffers(this.getSemibook("asks"), filter);
  }

  /** Pretty prints the current state of the bids of the market */
  consoleBids(filter?: prettyPrintFilter): void {
    this.prettyP.consoleOffers(this.getSemibook("bids"), filter);
  }

  /** Pretty prints the current state of the asks or bids of the market */
  prettyPrint(ba: Market.BA, filter: prettyPrintFilter): void {
    const offers = this.getSemibook(ba);
    this.prettyP.prettyPrint(offers, filter);
  }

  /**
   * Subscribe to order book updates.
   *
   * `cb` gets called whenever the order book is updated.
   *  Its first argument `event` is a summary of the event. It has the following properties:
   *
   * * `type` the type of change. May be: * `"OfferWrite"`: an offer was
   * inserted  or moved in the book.  * `"OfferFail"`, `"OfferSuccess"`,
   * `"OfferRetract"`: an offer was removed from the book because it failed,
   * succeeded, or was canceled.
   *
   * * `ba` is either `"bids"` or `"asks"`. The offer concerned by the change is
   * either an ask (an offer for `base` asking for `quote`) or a bid (`an offer
   * for `quote` asking for `base`).
   *
   * * `offer` is information about the offer, see type `Offer`.
   *
   * * `taker`, `takerWants`, `takerGives` (for `"OfferFail"` and
   * `"OfferSuccess"` only): address of the taker who executed the offer as well
   * as the volumes that were requested by the taker.
   *
   * * `mgvData` : extra data from mangrove and the maker
   * contract. See the [Mangrove contracts documentation](#TODO) for the list of possible status codes.
   *
   * `opts` may specify the maximum of offers to read initially, and the chunk
   * size used when querying the reader contract (always ran locally).
   *
   * @example
   * ```
   * const market = await mgv.market({base:"USDC",quote:"DAI"}
   * market.subscribe((event,utils) => console.log(event.type, utils.book()))
   * ```
   *
   * @note Only one subscription may be active at a time.
   */
  subscribe(cb: Market.MarketCallback<void>): void {
    this.#subscriptions.set(cb, { type: "multiple" });
  }

  /**
   *  Returns a promise which is fulfilled after execution of the callback.
   */
  async once<T>(
    cb: Market.MarketCallback<T>,
    filter?: Market.MarketFilter
  ): Promise<T> {
    return new Promise((ok, ko) => {
      const params: Market.SubscriptionParam = { type: "once", ok, ko };
      if (typeof filter !== "undefined") {
        params.filter = filter;
      }
      this.#subscriptions.set(cb as Market.StorableMarketCallback, params);
    });
  }

  /* Stop calling a user-provided function on book-related events. */
  unsubscribe(cb: Market.StorableMarketCallback): void {
    this.#subscriptions.delete(cb);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  getOutboundInbound(ba: Market.BA): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return Market.getOutboundInbound(ba, this.base, this.quote);
  }

  /** Determine which token will be Mangrove's outbound/inbound depending on whether you're working with bids or asks. */
  static getOutboundInbound(
    ba: Market.BA,
    base: MgvToken,
    quote: MgvToken
  ): {
    outbound_tkn: MgvToken;
    inbound_tkn: MgvToken;
  } {
    return {
      outbound_tkn: ba === "asks" ? base : quote,
      inbound_tkn: ba === "asks" ? quote : base,
    };
  }

  /** Determine whether gives or wants will be baseVolume/quoteVolume depending on whether you're working with bids or asks. */
  static getBaseQuoteVolumes(
    ba: Market.BA,
    gives: Big,
    wants: Big
  ): { baseVolume: Big; quoteVolume: Big } {
    return {
      baseVolume: ba === "asks" ? gives : wants,
      quoteVolume: ba === "asks" ? wants : gives,
    };
  }

  /** Determine the price from dividing offer gives with wants depending on whether you're working with bids or asks. */
  static getPrice(ba: Market.BA, gives: Big, wants: Big): Big | undefined {
    const { baseVolume, quoteVolume } = Market.getBaseQuoteVolumes(
      ba,
      gives,
      wants
    );
    return baseVolume.gt(0) ? quoteVolume.div(baseVolume) : undefined;
  }

  /** Determine the wants from gives and price depending on whether you're working with bids or asks. */
  static getWantsForPrice(ba: Market.BA, gives: Big, price: Big): Big {
    return ba === "asks" ? gives.mul(price) : gives.div(price);
  }

  /** Determine the gives from wants and price depending on whether you're working with bids or asks. */
  static getGivesForPrice(ba: Market.BA, wants: Big, price: Big): Big {
    return ba === "asks" ? wants.div(price) : wants.mul(price);
  }

  /** Determine gives and wants from a volume (in base) and a price depending on whether you're working with bids or asks. */
  static getGivesWantsForVolumeAtPrice(
    ba: Market.BA,
    volume: Big,
    price: Big
  ): { gives: Big; wants: Big } {
    const gives = ba === "asks" ? volume : volume.mul(price);
    const wants = ba === "asks" ? volume.mul(price) : volume;
    return {
      gives,
      wants,
    };
  }

  /** Determine the first decimal place where the smallest price difference between neighboring offers in the order book cache is visible. */
  getDisplayDecimalsForPriceDifferences(): number {
    const books = this.getBook();
    return Market.getDisplayDecimalsForPriceDifferences([
      ...books.asks,
      ...[...books.bids].slice().reverse(),
    ]);
  }

  /** Determine the first decimal place where the smallest price difference between neighboring offers is visible. */
  static getDisplayDecimalsForPriceDifferences(offers: Market.Offer[]): number {
    if (offers.length <= 1) {
      return 0;
    }

    const absPriceDiffs = new Array<Big | undefined>(offers.length - 1);
    offers.slice(1).reduce((prevPrice, o, i) => {
      absPriceDiffs[i] =
        prevPrice === undefined || o.price === undefined
          ? undefined
          : prevPrice.sub(o.price).abs();
      return o.price;
    }, offers[0].price);

    const minBig = (
      b1: Big | undefined,
      b2: Big | undefined
    ): Big | undefined => {
      if (b1 === undefined) {
        return b2;
      } else if (b2 === undefined) {
        return b1;
      }
      return b1.lt(b2) ? b1 : b2;
    };
    const minAbsPriceDiff = absPriceDiffs
      .filter((d) => !(d === undefined || d.eq(0)))
      .reduce(minBig, undefined);

    return minAbsPriceDiff === undefined
      ? 0
      : -Math.floor(Math.log10(minAbsPriceDiff.toNumber()));
  }
}

export default Market;

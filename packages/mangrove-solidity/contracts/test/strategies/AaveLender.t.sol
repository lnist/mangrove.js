// SPDX-License-Identifier:	AGPL-3.0
pragma solidity ^0.8.10;

import "mgv_test/lib/MangroveTest.sol";
import "mgv_test/lib/Fork.sol";
import "mgv_src/toy_strategies/single_user/cash_management/AdvancedAaveRetail.sol";

// warning! currently only known to work on Polygon, block 26416000
// at a later point, Aave disables stable dai borrowing which those tests need
contract AaveLenderTest is MangroveTest {
  IERC20 weth;
  IERC20 dai;
  // BufferedAaveRouter router;
  AdvancedAaveRetail strat;
  address payable maker;

  receive() external payable {}

  function setUp() public override {
    Fork.setUp();
    dai = IERC20(Fork.DAI);
    weth = IERC20(Fork.WETH);
    mgv = setupMangrove(dai, weth);
    mgv.fund{value: 10 ether}();

    weth.approve($(mgv), type(uint).max);
    dai.approve($(mgv), type(uint).max);
    // logging
    vm.label(tx.origin, "tx.origin");
    vm.label($(this), "Test runner");
    vm.label($(mgv), "mgv");

    // sets fee to 30 so redirecting fees to mgv itself to avoid crediting maker
    mgv.setFee($(weth), $(dai), 30);
    mgv.setFee($(dai), $(weth), 30);
    mgv.setVault($(mgv));

    maker = freshAddress("maker");

    deal($(weth), $(this), 10 ether);
    deal($(dai), $(this), 10_000 ether);
  }

  function test_run() public {
    deployStrat();

    execTraderStrat();
  }

  function deployStrat() public {
    strat = new AdvancedAaveRetail({
      addressesProvider: Fork.AAVE,
      _MGV: IMangrove($(mgv)),
      deployer: $(this)
    });
    // note for later: compound is
    //   simple/advanced compoudn= Contract.deploy(Fork.COMP,IMangrove($(mgv)),Fork.WETH,$(this));
    //   market = [Fork.CWETH,Fork.CDAI];

    // aave rejects market entering if underlying balance is 0 (will self enter at first deposit)
    // enterMarkets = false; // compound should have it set to true
    // provisioning Mangrove on behalf of MakerContract
    mgv.fund{value: 2 ether}($(strat));

    // testSigner approves Mangrove for WETH/DAI before trying to take offers
    weth.approve($(mgv), type(uint).max);
    dai.approve($(mgv), type(uint).max);

    // offer should get/put base/quote tokens on lender contract (OK since sender is MakerContract admin)
    // strat.enterMarkets(market); // not on aave

    strat.approveMangrove(dai, type(uint).max);
    strat.approveMangrove(weth, type(uint).max);

    // One sends 1000 DAI to MakerContract
    dai.transfer($(strat), 1000 ether);

    // testSigner asks makerContract to approve lender to be able to mint [c/a]Token
    strat.approveLender(weth, type(uint).max);
    // NB in the special case of cEth this is only necessary to repay debt
    strat.approveLender(dai, type(uint).max);

    // makerContract deposits some DAI on Lender (remains 100 DAIs on the contract)
    strat.mint(dai, 900 ether, $(strat));
  }

  function execTraderStrat() public {
    // TODO logLenderStatus
    uint offerId = strat.newOffer(
      IOfferLogic.MakerOrder({
        outbound_tkn: dai,
        inbound_tkn: weth,
        wants: 0.15 ether,
        gives: 300 ether,
        gasreq: strat.OFR_GASREQ(),
        gasprice: 0,
        pivotId: 0
      })
    );

    uint balanceBefore = strat.overlying(weth).balanceOf($(strat));
    // console.log("balanceBefore",balanceBefore);
    (, , uint gave, , ) = mgv.snipes({
      outbound_tkn: $(dai),
      inbound_tkn: $(weth),
      targets: inDyn([offerId, 300 ether, 0.15 ether, type(uint).max]),
      fillWants: true
    });

    // TODO logLenderStatus
    expectAmountOnLender(dai, 700 ether, 0, $(strat));
    expectAmountOnLender(weth, gave, 0, $(strat));

    strat.approveMangrove(weth, type(uint).max);

    offerId = strat.newOffer(
      IOfferLogic.MakerOrder({
        outbound_tkn: weth,
        inbound_tkn: dai,
        wants: 380 ether,
        gives: 0.2 ether,
        gasreq: strat.OFR_GASREQ(),
        gasprice: 0,
        pivotId: 0
      })
    );

    vm.warp(block.timestamp + 10);
    (, uint got2, uint gave2, , ) = mgv.snipes({
      outbound_tkn: $(weth),
      inbound_tkn: $(dai),
      targets: inDyn([offerId, 0.2 ether, 380 ether, type(uint).max]),
      fillWants: true
    });
    // console.log("got2",got2);
    // console.log("gave2",gave2);

    // // TODO logLenderStatus

    expectAmountOnLender(weth, 0, 0.05 ether, $(strat));

    offerId = strat.newOffer(
      IOfferLogic.MakerOrder({
        outbound_tkn: dai,
        inbound_tkn: weth,
        wants: 0.63 ether,
        gives: 1500 ether,
        gasreq: strat.OFR_GASREQ(),
        gasprice: 0,
        pivotId: 0
      })
    );

    mgv.snipes({
      outbound_tkn: $(dai),
      inbound_tkn: $(weth),
      targets: inDyn([offerId, 1500 ether, 0.63 ether, type(uint).max]),
      fillWants: true
    });

    // TODO logLenderStatus

    // TODO check borrowing DAIs and not borrowing WETHs anymore
  }

  /// start with 900 DAIs on lender and 100 DAIs locally
  /// newOffer: wants 0.15 ETHs for 300 DAIs
  /// taker snipes (full)
  /// now 700 DAIs on lender, 0 locally and 0.15 ETHs
  /// newOffer: wants 380 DAIs for 0.2 ETHs
  /// borrows 0.05 ETHs using 1080 DAIs of collateral
  /// now 1080 DAIs - locked DAI and 0 ETHs (borrower of 0.05 ETHs)
  /// newOffer: wants 0.63 ETHs for 1500 DAIs
  /// repays the full debt and borrows the missing part in DAI
  function execLenderStrat() public {
    // TODO logLenderStatus

    // posting new offer on Mangrove via the MakerContract `newOffer` external function
    uint offerId = strat.newOffer(
      IOfferLogic.MakerOrder({
        outbound_tkn: dai,
        inbound_tkn: weth,
        wants: 0.5 ether,
        gives: 1000 ether,
        gasreq: strat.OFR_GASREQ(),
        gasprice: 0,
        pivotId: 0
      })
    );

    mgv.snipes({
      outbound_tkn: $(dai),
      inbound_tkn: $(weth),
      targets: inDyn([offerId, 800 ether, 0.5 ether, type(uint).max]),
      fillWants: true
    });

    expectAmountOnLender(dai, 200 ether, 0, $(strat));
    expectAmountOnLender(weth, 0.4 ether, 0, $(strat));
  }

  function expectAmountOnLender(
    IERC20 underlying,
    uint expected_balance,
    uint expected_borrow,
    address account
  ) public {
    // nb for later: compound
    //   balance = overlyings(underlying).balanceOfUnderlying(account);
    //   borrow = overlyings(underlying).borrowBalanceCurrent(account);
    uint balance = strat.overlying(underlying).balanceOf(account);
    uint borrow = strat.borrowed($(underlying), account);
    // console.log("expected balance",expected_balance);
    // console.log("         balance",balance);
    // console.log("expected borrow", expected_borrow);
    // console.log("         borrow", borrow);
    assertApproxEq(balance, expected_balance, (10**14) / 2);
    assertApproxEq(borrow, expected_borrow, (10**14) / 2);
  }
}

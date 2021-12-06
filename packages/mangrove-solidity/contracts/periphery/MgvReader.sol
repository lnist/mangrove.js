// SPDX-License-Identifier:	AGPL-3.0

// MgvReader.sol

// Copyright (C) 2021 Giry SAS.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
pragma solidity ^0.8.10;
pragma abicoder v2;
import {MgvLib as ML, P} from "../MgvLib.sol";

interface MangroveLike {
  function best(address, address) external view returns (uint);

  function offers(
    address,
    address,
    uint
  ) external view returns (P.Offer.t);

  function offerDetails(
    address,
    address,
    uint
  ) external view returns (bytes32);

  function offerInfo(
    address,
    address,
    uint
  ) external view returns (P.Structs.Offer memory, P.Structs.OfferDetail memory);

  function config(address, address) external view returns (P.Global.t, P.Local.t);
}

contract MgvReader {
  using P.Offer for P.Offer.t;
  using P.Global for P.Global.t;
  using P.Local for P.Local.t;
  MangroveLike immutable mgv;

  constructor(address _mgv) {
    mgv = MangroveLike(payable(_mgv));
  }

  /*
   * Returns two uints.
   *
   * `startId` is the id of the best live offer with id equal or greater than
   * `fromId`, 0 if there is no such offer.
   *
   * `length` is 0 if `startId == 0`. Other it is the number of live offers as good or worse than the offer with
   * id `startId`.
   */
  function offerListEndPoints(
    address outbound_tkn,
    address inbound_tkn,
    uint fromId,
    uint maxOffers
  ) public view returns (uint startId, uint length) { unchecked {
    if (fromId == 0) {
      startId = mgv.best(outbound_tkn, inbound_tkn);
    } else {
      startId = mgv.offers(outbound_tkn, inbound_tkn, fromId).gives()
      > 0
        ? fromId
        : 0;
    }

    uint currentId = startId;

    while (currentId != 0 && length < maxOffers) {
      currentId = mgv.offers(outbound_tkn, inbound_tkn, currentId).next();
      length = length + 1;
    }

    return (startId, length);
  }}

  // Returns the orderbook for the outbound_tkn/inbound_tkn pair in packed form. First number is id of next offer (0 is we're done). First array is ids, second is offers (as bytes32), third is offerDetails (as bytes32). Array will be of size `min(# of offers in out/in list, maxOffers)`.
  function packedOfferList(
    address outbound_tkn,
    address inbound_tkn,
    uint fromId,
    uint maxOffers
  )
    public
    view
    returns (
      uint,
      uint[] memory,
      P.Offer.t[] memory,
      bytes32[] memory
    )
  { unchecked {
    (uint currentId, uint length) = offerListEndPoints(
      outbound_tkn,
      inbound_tkn,
      fromId,
      maxOffers
    );

    uint[] memory offerIds = new uint[](length);
    P.Offer.t[] memory offers = new P.Offer.t[](length);
    bytes32[] memory details = new bytes32[](length);

    uint i = 0;

    while (currentId != 0 && i < length) {
      offerIds[i] = currentId;
      offers[i] = mgv.offers(outbound_tkn, inbound_tkn, currentId);
      details[i] = mgv.offerDetails(outbound_tkn, inbound_tkn, currentId);
      currentId = offers[i].next();
      i = i + 1;
    }

    return (currentId, offerIds, offers, details);
  }}
  // Returns the orderbook for the outbound_tkn/inbound_tkn pair in unpacked form. First number is id of next offer (0 if we're done). First array is ids, second is offers (as structs), third is offerDetails (as structs). Array will be of size `min(# of offers in out/in list, maxOffers)`.
  function offerList(
    address outbound_tkn,
    address inbound_tkn,
    uint fromId,
    uint maxOffers
  )
    public
    view
    returns (
      uint,
      uint[] memory,
      P.Structs.Offer[] memory,
      P.Structs.OfferDetail[] memory
    )
  { unchecked {
    (uint currentId, uint length) = offerListEndPoints(
      outbound_tkn,
      inbound_tkn,
      fromId,
      maxOffers
    );

    uint[] memory offerIds = new uint[](length);
    P.Structs.Offer[] memory offers = new P.Structs.Offer[](length);
    P.Structs.OfferDetail[] memory details = new P.Structs.OfferDetail[](length);

    uint i = 0;
    while (currentId != 0 && i < length) {
      offerIds[i] = currentId;
      (offers[i], details[i]) = mgv.offerInfo(
        outbound_tkn,
        inbound_tkn,
        currentId
      );
      currentId = offers[i].next;
      i = i + 1;
    }

    return (currentId, offerIds, offers, details);
  }}

  function getProvision(
    address outbound_tkn,
    address inbound_tkn,
    uint ofr_gasreq,
    uint ofr_gasprice
  ) external view returns (uint) { unchecked {
    (P.Global.t global, P.Local.t local) = mgv.config(outbound_tkn, inbound_tkn);
    uint _gp;
    uint global_gasprice = global.gasprice();
    if (global_gasprice > ofr_gasprice) {
      _gp = global_gasprice;
    } else {
      _gp = ofr_gasprice;
    }
    return
      (ofr_gasreq +
      local.overhead_gasbase() +
        local.offer_gasbase()) *
      _gp *
      10**9;
  }}

  /* Returns the configuration in an ABI-compatible struct. Should not be called internally, would be a huge memory copying waste. Use `config` instead. */
  function config(address outbound_tkn, address inbound_tkn)
    external
    view
    returns (ML.Global memory global, ML.Local memory local)
  { unchecked {
    (P.Global.t _global, P.Local.t _local) = mgv.config(outbound_tkn, inbound_tkn);
    global = ML.Global({
      monitor: _global.monitor(),
      useOracle: _global.useOracle() > 0,
      notify: _global.notify() > 0,
      gasprice: _global.gasprice(),
      gasmax: _global.gasmax(),
      dead: _global.dead() > 0
    });
    local = ML.Local({
      active: _local.active() > 0,
      overhead_gasbase: _local.overhead_gasbase(),
      offer_gasbase: _local.offer_gasbase(),
      fee: _local.fee(),
      density: _local.density(),
      best: _local.best(),
      lock: _local.lock() > 0,
      last: _local.last()
    });
    // global = _global.to_struct();
    // local = _local.to_struct();
  }}
}

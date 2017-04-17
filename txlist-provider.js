
const { inherits } = require('util')
const async = require('async')
const xhr = process.browser ? require('xhr') : require('request')
const EthQuery = require('eth-store/query')
const {
  findAllTxs,
  findAllTxsTo,
  findAllTxsInRange
} = require('eth-tx-finder')

const noop = function () {}

// const RPC_ENDPOINT = 'https://mainnet.infura.io/'
const targetAccount = '0x6aaa5f611b08f8ae98d377ba3f09b1717822b322'
// const targetAccount = '0x7773dc77b66d96ee4c2f72cdc402349366c7b11d'

const Subprovider = require('web3-provider-engine/subproviders/subprovider')

inherits(TxListProvider, Subprovider)
module.exports = TxListProvider

function TxListProvider (opts) {
  if (!opts.rpcUrl) throw new Error('expected "rpcUrl"')

  this.rpcUrl = opts.rpcUrl
}

TxListProvider.prototype.handleRequest = function (payload, next, end) {
  switch (payload.method) {
    case 'eth_listTransactions':
      listTransactions({
        address: payload.params[0],
        startblock: payload.params[1],
        endblock: payload.params[2],
        rpcUrl: this.rpcUrl
      }, end)

      break
    default:
      next()
      break
  }
}

function flatten (arr) {
  return arr.reduce(function (all, some) {
    return all.concat(some)
  }, [])
}

function listTransactions ({ address, startblock=0, endblock=Infinity, rpcUrl }, cb) {
  findTxsFrom({ address, startblock, endblock, rpcUrl }, function (err, from) {
    if (err) return cb(err)

    findTxsTo({ address, startblock, endblock, rpcUrl }, function (err, to) {
      if (err) return cb(err)

      cb(null, from.concat(to))
    })
  })
}

function findTxsTo ({ address, startblock, endblock, rpcUrl }, cb) {
  const provider = {
    sendAsync: sendAsync.bind(null, rpcUrl)
  }

  let foundTxCount = 0
  if (startblock === 0 && endblock === Infinity) {
    return findAllTxsTo(provider, address, noop, cb)
  }

  findAllTxsInRangeTo(provider, address, startblock, endblock, noop, cb)
}

function findTxsFrom ({ address, startblock, endblock, rpcUrl }, cb) {
  const provider = {
    sendAsync: sendAsync.bind(null, rpcUrl)
  }

  let foundTxCount = 0
  if (startblock === 0 && endblock === Infinity) {
    return findAllTxs(provider, address, noop, cb)
  }

  const query = new EthQuery(provider)
  async.parallel({
    earliest: query.getNonce.bind(query, address, startblock),
    latest:   query.getNonce.bind(query, address, endblock),
  }, function (err, results) {
    if (err) return cb(err)

    findAllTxsInRange(provider, address, startblock, endblock, noop, cb)
  })
}

function sendAsync (rpcUrl, payload, cb) {
  const requestParams = {
    uri: rpcUrl,
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    rejectUnauthorized: false,
  }

  const req = xhr(requestParams, function(err, res, body) {
    if (err) return cb(err)

    // parse response
    let data
    try {
      data = JSON.parse(body)
    } catch (err) {
      // console.error(RPC_ENDPOINT)
      // console.error(body)
      // console.error(err.stack)
      return cb(err)
    }

    if (data.error) return cb(data.error)

    // console.log('network:', payload.method, payload.params, '->', data.result)
    cb(null, data)
  })
}

// util

function hexToNumber(hexString){
  return parseInt(hexString, 16)
}

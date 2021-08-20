
const { inherits } = require('util')
const xhr = process.browser ? require('xhr') : require('request')
const EthQuery = require('@tradle/eth-store/query')
const TxFinder = require('@tradle/eth-tx-finder')
const { promisify, flatten } = require('./utils')
const findAllTxs = promisify(TxFinder.findAllTxs)
const findAllTxsTo = promisify(TxFinder.findAllTxsTo)
const findAllTxsInRange = promisify(TxFinder.findAllTxsInRange)
const findAllTxsInRangeTo = promisify(TxFinder.findAllTxsInRangeTo)
const Subprovider = require('@tradle/web3-provider-engine/subproviders/subprovider')

const noop = function () {}

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

const listTransactions = async ({ address, startblock=0, endblock=Infinity, rpcUrl }) => {
  const results = Promise.all([
    findTxsFrom({ address, startblock, endblock, rpcUrl }),
    findTxsTo({ address, startblock, endblock, rpcUrl })
  ])

  return flatten(results)
}

const findTxsTo = ({ address, startblock, endblock, rpcUrl }) => {
  const provider = {
    sendAsync: sendAsync.bind(null, rpcUrl)
  }

  if (startblock === 0 && endblock === Infinity) {
    return findAllTxsTo(provider, address, noop)
  }

  return findAllTxsInRangeTo(provider, address, startblock, endblock, noop)
}

const findTxsFrom = async ({ address, startblock, endblock, rpcUrl }) => {
  const provider = {
    sendAsync: sendAsync.bind(null, rpcUrl)
  }

  if (startblock === 0 && endblock === Infinity) {
    return findAllTxs(provider, address, noop)
  }

  const query = new EthQuery(provider)

  // FIXME: can't remember the point of this or how it works
  const [earliest, latest] = await Promise.all([
    promisify(query.getNonce).bind(query, address, startblock),
    promisify(query.getNonce).bind(query, address, endblock),
  ])

  return findAllTxsInRange(provider, address, startblock, endblock, noop)
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

  xhr(requestParams, function(err, res, body) {
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

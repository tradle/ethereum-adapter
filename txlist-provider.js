
const { fetch } = require('cross-fetch')
const EthQuery = require('@tradle/eth-store/query')
const {
  findAllTxs,
  findAllTxsTo,
  findAllTxsInRange,
  findAllTxsInRangeTo
} = require('@tradle/eth-tx-finder')
const { flatten } = require('./utils')
const Subprovider = require('@tradle/web3-provider-engine/subproviders/subprovider')

const noop = function () {}

class TxListProvider extends Subprovider {
  constructor (opts = {}) {
    super()
    if (!opts.rpcUrl) throw new Error('expected "rpcUrl"')

    this.rpcUrl = opts.rpcUrl
  }

  handleRequest (payload, next, end) {
    switch (payload.method) {
      case 'eth_listTransactions':
        listTransactions({
          address: payload.params[0],
          startblock: payload.params[1],
          endblock: payload.params[2],
          rpcUrl: this.rpcUrl
        }).then(
          data => end(null, data),
          err => end(err)
        )
        break
      default:
        next()
        break
    }
  }
}

async function listTransactions ({ address, startblock = 0, endblock = Infinity, rpcUrl }) {
  const results = await Promise.all([
    findTxsFrom({ address, startblock, endblock, rpcUrl }),
    findTxsTo({ address, startblock, endblock, rpcUrl })
  ])

  return flatten(results)
}

function findTxsTo ({ address, startblock, endblock, rpcUrl }) {
  const provider = {
    sendPromise: payload => sendPromise(rpcUrl, payload)
  }

  if (startblock === 0 && endblock === Infinity) {
    return findAllTxsTo(provider, address, noop)
  }

  return findAllTxsInRangeTo(provider, address, startblock, endblock, noop)
}

async function findTxsFrom ({ address, startblock, endblock, rpcUrl }) {
  const provider = {
    sendPromise: payload => sendPromise(rpcUrl, payload)
  }

  if (startblock === 0 && endblock === Infinity) {
    return findAllTxs(provider, address, noop)
  }

  const query = new EthQuery(provider)

  // FIXME: can't remember the point of this or how it works
  await Promise.all([
    query.getNonce(query, address, startblock),
    query.getNonce(query, address, endblock)
  ])

  return findAllTxsInRange(provider, address, startblock, endblock, noop)
}

async function sendPromise (rpcUrl, payload) {
  const body = JSON.stringify(payload)
  const opts = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body,
    rejectUnauthorized: false
  }

  const res = await fetch(rpcUrl, opts)
  const data = await res.json()

  if (data.error) {
    throw new Error(`Error from rpc: ${JSON.stringify(data.error)} for ${body}`)
  }
  return data
}

module.exports = TxListProvider

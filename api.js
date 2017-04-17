const { mapLimit } = require('async')
const extend = require('xtend/mutable')
const omit = require('object.omit')
const lexint = require('lexicographic-integer')
const ProviderEngine = require('web3-provider-engine')
const DefaultFixture = require('web3-provider-engine/subproviders/default-fixture.js')
const NonceTrackerSubprovider = require('web3-provider-engine/subproviders/nonce-tracker.js')
const CacheSubprovider = require('web3-provider-engine/subproviders/cache.js')
const FilterSubprovider = require('web3-provider-engine/subproviders/filters.js')
const HookedWalletSubprovider = require('web3-provider-engine/subproviders/hooked-wallet.js')
const SanitizingSubprovider = require('web3-provider-engine/subproviders/sanitizer.js')
const RpcSubprovider = require('web3-provider-engine/subproviders/rpc.js')
const EtherscanSubprovider = require('web3-provider-engine/subproviders/etherscan')
const TxListSubprovider = require('./txlist-provider')
const GasPriceSubprovider = require('web3-provider-engine/subproviders/gasprice.js')
const VMSubprovider = require('web3-provider-engine/subproviders/vm.js')
const createPayload = require('web3-provider-engine/util/create-payload')
const Wallet = require('ethereumjs-wallet')
const WalletSubprovider = require('ethereumjs-wallet/provider-engine')
const ethUtil = require('ethereumjs-util')

const MAX_CONCURRENT_REQUESTS = 3

module.exports = function createAPI (opts) {
  const { networkName, constants } = opts
  const blockchainOpts = omit(opts, ['networkName', 'constants'])

  function polite (engine, fn) {
    let ready
    engine.once('ready', () => ready = true)
    return function () {
      const args = arguments
      if (ready) return fn.apply(this, args)

      engine.once('block', () => {
        fn.apply(this, args)
      })
    }
  }

  function createBlockchainAPI () {
    const engine = createEngine(blockchainOpts)

    let chainHeight

    engine.on('block', ({ number }) => {
      chainHeight = unhexint(number)
    })

    const send = sendPayload.bind(null, engine)
    const blockchain = {
      close: engine.stop.bind(engine),
      info: polite(engine, getLatestBlock),
      blocks: {
        latest: polite(engine, getLatestBlock)
      },
      transactions: {
        get: polite(engine, getTxs),
        propagate: polite(engine, sendRawTx)
      },
      addresses: {
        transactions: polite(engine, getTxsForAccounts)
      },
      _advanceToNextBlock: function () {
      }
    }

    return blockchain

    function getLatestBlock (cb) {
      process.nextTick(() => cb(null, { blockHeight: chainHeight }))

      // send(createPayload({
      //   method: 'eth_blockNumber',
      //   params: []
      // }), function (err, result) {
      //   if (err) return cb(err)

      //   cb(null, {
      //     blockHeight: unhexint(result)
      //   })
      // })
    }

    function getTxs (hashes, cb) {
      mapLimit(hashes, MAX_CONCURRENT_REQUESTS, getTx, cb)
    }

    function getTx (hash, cb) {
      send(createPayload({
        method: 'eth_getTransactionByHash',
        params: [prefixHex(hash)],
      }), cb)
    }

    function sendRawTx (txHex, cb) {
      send(createPayload({
        method: 'eth_sendRawTransaction',
        params: [txHex],
      }), cb)
    }

    function getTxsForAccounts (addresses, height, cb) {
      if (typeof height === 'function') {
        cb = height
        height = undefined
      }

      if (height && height > chainHeight) return cb(null, [])

      mapLimit(addresses, MAX_CONCURRENT_REQUESTS, function (address, done) {
        getTxsForAccount(address, height, done)
      }, function (err, results) {
        if (err) return cb(err)

        cb(null, flatten(results))
      })
    }

    function getTxsForAccount (addressHex, height, cb) {
      send(createPayload({
        method: 'eth_listTransactions',
        params: [
          prefixHex(addressHex),
          height,
          undefined, // blockHeight,
          'asc'
        ],
      }), function (err, result) {
        if (err) return cb(err)

        // Etherscan.io
        //
        // { result: [{ blockNumber: '1961866',
        //        timeStamp: '1469624867',
        //        hash: '0x545243f19ede50b8115e6165ffe509fde4bb1abc20f287cd8c49c97f39836efe',
        //        nonce: '22',
        //        blockHash: '0x9ba94fe0b81b32593fd547c39ccbbc2fc14b1bdde4ccc6dccb79e2a304280d50',
        //        transactionIndex: '5',
        //        from: '0xddbd2b932c763ba5b1b7ae3b362eac3e8d40121a',
        //        to: '0x1bb0ac60363e320bc45fdb15aed226fb59c88e44',
        //        value: '10600000000000000000000',
        //        gas: '127964',
        //        gasPrice: '20000000000',
        //        isError: '0',
        //        input: '0x',
        //        contractAddress: '',
        //        cumulativeGasUsed: '227901',
        //        gasUsed: '27964',
        //        confirmations: '1356689' }]}

        result = result.map(txInfo => {
          const blockHeight = Number(txInfo.blockNumber)
          chainHeight = Math.max(chainHeight, blockHeight)
          return {
            blockHeight,
            txId: unprefixHex(txInfo.hash),
            confirmations: chainHeight - blockHeight,
            from: {
              addresses: [txInfo.from].map(unprefixHex)
            },
            to: {
              addresses: [txInfo.to].map(unprefixHex)
            }
          }
        })

        cb(null, result)
      })
    }
  }

  function createTransactor ({ wallet, privateKey }) {
    if (!wallet) wallet = Wallet.fromPrivateKey(privateKey)

    const engine = createEngine(extend({
      wallet
    }, opts))

    let chainHeight

    engine.on('block', ({ number }) => {
      chainHeight = unhexint(number)
    })

    function signAndSend ({ to }, cb) {
      if (to.length !== 1) throw new Error('only one recipient allowed')

      to = to.map(({ address, amount }) => {
        return {
          address: prefixHex(address),
          amount
        }
      })[0]

      // engine.sendAsync(createPayload({
      //   method: 'eth_getBalance',
      //   params: [wallet.getAddressString(), 'latest']
      // }), function (err, results) {
      //   console.log('BALANCE', err || results)
      // })

      engine.sendAsync(createPayload({
        method: 'eth_sendTransaction',
        params: [
          {
            // nonce: '0x00',
            // gas: 0,
            // gasPrice: 100,
            // gasLimit: 0,
            from: wallet.getAddressString(),
            to: to.address, //'0xbed89f9d47ae4f38045da1a45d99589f75eae942',
            value: hexint(to.amount), // '0x01',
            // EIP 155 chainId - mainnet: 1, ropsten: 3
            chainId: constants.chainId
          }
        ]
      }), function (err, response) {
        if (err) return cb(err)

        const txId = response.result
        cb(null, { txId })
      })
    }

    return {
      multipleRecipientsAllowed: false,
      send: polite(engine, signAndSend),
      close: engine.stop.bind(engine)
    }
  }

  function split (arr, batchSize) {
    const batches = []
    while (arr.length > batchSize){
      let batch = arr.splice(0, batchSize)
      batches.push(batch)
    }

    return batches
  }

  return {
    blockchain: 'ethereum',
    name: networkName,
    minOutputAmount: 1,
    constants,
    pubKeyToAddress,
    createBlockchainAPI,
    createTransactor,
    generateKey
  }
}

function generateKey () {
  const key = Wallet.generate(true)
  const exported = {}

  // lazy
  Object.defineProperty(exported, 'pub', {
    get: function () {
      return key.pubKey
    }
  })

  Object.defineProperty(exported, 'priv', {
    get: function () {
      return key.privKey
    }
  })

  return exported
}

function pubKeyToAddress (pub) {
  if (pub.length === 65) pub = pub.slice(1)

  const prefixed = Wallet.fromPublicKey(pub).getAddressString()
  return unprefixHex(prefixed)
}

function createEngine (opts) {
  const { rpcUrl } = opts
  const engine = new ProviderEngine(opts)

  // static
  const staticSubprovider = new DefaultFixture(opts.static)
  engine.addProvider(staticSubprovider)

  // nonce tracker
  engine.addProvider(new NonceTrackerSubprovider())

  // sanitization
  const sanitizer = new SanitizingSubprovider()
  engine.addProvider(sanitizer)

  // cache layer
  const cacheSubprovider = new CacheSubprovider()
  engine.addProvider(cacheSubprovider)

  // filters
  const filterSubprovider = new FilterSubprovider()
  engine.addProvider(filterSubprovider)

  let wallet
  if (opts.wallet || opts.privateKey) {
    wallet = opts.wallet || Wallet.fromPrivateKey(opts.privateKey)
    engine.addProvider(new WalletSubprovider(wallet, opts))
    // id mgmt
    const idmgmtSubprovider = new HookedWalletSubprovider({
      // accounts
      getAccounts: opts.getAccounts,
      // transactions
      processTransaction: opts.processTransaction,
      approveTransaction: opts.approveTransaction,
      signTransaction: opts.signTransaction,
      publishTransaction: opts.publishTransaction,
      // messages
      // old eth_sign
      processMessage: opts.processMessage,
      approveMessage: opts.approveMessage,
      signMessage: opts.signMessage,
      // new personal_sign
      processPersonalMessage: opts.processPersonalMessage,
      approvePersonalMessage: opts.approvePersonalMessage,
      signPersonalMessage: opts.signPersonalMessage,
      personalRecoverSigner: opts.personalRecoverSigner,
    })

    engine.addProvider(idmgmtSubprovider)
  }

  engine.addProvider(new GasPriceSubprovider())
  engine.addProvider(new VMSubprovider())

  // data sources
  if (rpcUrl) {
    engine.addProvider(new TxListSubprovider({ rpcUrl }))
    engine.addProvider(new RpcSubprovider({ rpcUrl }))
  }

  engine.addProvider(new EtherscanSubprovider({ network: opts.networkName }))
  engine.start()
  return engine
}

function normalizeError (err, response) {
  if (response && response.error) {
    err = response.error
  }

  if (!(err instanceof Error)) {
    if (typeof err === 'object') err = JSON.stringify(err)
    if (typeof err === 'string') err = new Error(err)
  }

  return err
}

function wrapCB (cb) {
  return function (err, response) {
    if (err) return cb(normalizeError(err, response))

    cb(null, response.result)
  }
}

function sendPayload (engine, payload, cb) {
  return engine.sendAsync(payload, wrapCB(cb))
}

function unhexint (val) {
  if (Buffer.isBuffer(val)) {
    return ethUtil.bufferToInt(val)
  }

  return parseInt(unprefixHex(val), 16)
}

function hexint (n) {
  return ethUtil.intToHex(n)
}

function unprefixHex (hex) {
  return hex.indexOf('0x') === 0 ? hex.slice(2) : hex
}

function prefixHex (hex) {
  return hex.indexOf('0x') === 0 ? hex : '0x' + hex
}

function flatten (arr) {
  return arr.reduce(function (all, some) {
    return all.concat(some)
  }, [])
}

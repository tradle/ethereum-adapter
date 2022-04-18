const { EventEmitter } = require('events')
const extend = require('xtend/mutable')
const clone = require('xtend')
const debug = require('debug')('@tradle/ethereum-adapter')
const BN = require('bn.js')
const pMemoize = require('p-memoize')
const ProviderEngine = require('@tradle/web3-provider-engine')
const DefaultFixture = require('@tradle/web3-provider-engine/subproviders/default-fixture.js')
const NonceTrackerSubprovider = require('@tradle/web3-provider-engine/subproviders/nonce-tracker.js')
const CacheSubprovider = require('@tradle/web3-provider-engine/subproviders/cache.js')
const FilterSubprovider = require('@tradle/web3-provider-engine/subproviders/filters.js')
const HookedWalletSubprovider = require('@tradle/web3-provider-engine/subproviders/hooked-wallet.js')
const SanitizingSubprovider = require('@tradle/web3-provider-engine/subproviders/sanitizer.js')
const RpcSubprovider = require('@tradle/web3-provider-engine/subproviders/rpc.js')
const EtherscanSubprovider = require('@tradle/web3-provider-engine/subproviders/etherscan')
const GasPriceSubprovider = require('@tradle/web3-provider-engine/subproviders/gasprice.js')
const createPayload = require('@tradle/web3-provider-engine/util/create-payload')
const Wallet = require('@tradle/ethereumjs-wallet')
const WalletSubprovider = require('@tradle/ethereumjs-wallet/provider-engine')
const ethUtil = require('ethereumjs-util')
const TxListSubprovider = require('./txlist-provider')
const { getSend, flatten, promisify } = require('./utils')
const networks = require('./networks')

const MAX_CONCURRENT_REQUESTS = 3
const ENGINE_READY_MAP = new WeakMap()
// see https://www.myetherwallet.com/helpers.html
const GWEI = 1000000000
const hexint = n => ethUtil.intToHex(n)
const unhexint = val => {
  if (typeof val === 'number') return val

  if (Buffer.isBuffer(val)) {
    return ethUtil.bufferToInt(val)
  }

  return parseInt(unprefixHex(val), 16)
}

const gasPriceByPriority = {
  // aim for next few minutes
  low: hexint(2 * GWEI), // 2 gwei
  mediumLow: hexint(5 * GWEI), // 5 gwei
  mediumHigh: hexint(10 * GWEI), // 10 gwei
  // aim for next few blocks
  high: hexint(20 * GWEI), // 20 gwei
  // aim for next block
  top: hexint(40 * GWEI) // 40 gwei
}

const GAS_FOR_TRANSFER = 21000

const promiseEngineReady = engine => {
  const ready = ENGINE_READY_MAP.get(engine)
  return new Promise(resolve => {
    if (ready) return resolve()

    engine.once('block', () => resolve())
  })
}

const createNetwork = ({ networkName, constants, engineOpts }) => {
  let api
  let engine

  const network = {
    blockchain: 'ethereum',
    name: networkName,
    minOutputAmount: 1,
    constants: constants || networks[networkName],
    curve: 'secp256k1',
    pubKeyToAddress,
    generateKey,
    get api () {
      if (!api) {
        api = network.createBlockchainAPI({ engine: network.engine })
      }

      return api
    },
    get engine () {
      if (!engine) {
        engine = createEngine(engineOpts)
      }

      return engine
    },
    createTransactor: (opts = {}) => createTransactor(extend({
      network,
      engine: network.engine
    }, opts)),
    createBlockchainAPI: (opts = {}) => createBlockchainAPI(extend({
      network,
      engine: network.engine
    }, opts))
  }

  return network
}

const createBlockchainAPI = ({ network, engine }) => {
  const ready = promiseEngineReady(engine)
  const stop = promisify(engine.stop.bind(engine))
  const start = promisify(engine.start.bind(engine))
  const send = getSend(engine)
  let blockHeight

  engine.on('block', ({ number }) => {
    blockHeight = unhexint(number)
    blockchain.emit('block', { blockHeight })
  })

  const requireReady = fn => (...args) => ready.then(() => fn(...args))
  const getLatestBlock = () => Promise.resolve({ blockHeight })
  const getTxs = hashes => Promise.map(hashes, getTx, { concurrency: MAX_CONCURRENT_REQUESTS })
  const getTx = async hash => send(createPayload({
    method: 'eth_getTransactionByHash',
    params: [prefixHex(hash)]
  }))

  const sendRawTx = async (txHex) => send(createPayload({
    method: 'eth_sendRawTransaction',
    params: [txHex]
  }))

  const getTxsForAccounts = async (addresses, height) => {
    if (height && height > blockHeight) return []

    addresses = addresses.filter(address => {
      if (!address) {
        // eslint-disable-next-line no-console
        console.warn('undefined address passed in')
      }

      return address
    })

    const results = await Promise.map(addresses, address => getTxsForAccount(address, height), { concurrency: MAX_CONCURRENT_REQUESTS })
    return flatten(results)
  }

  const getTxsForAccount = async (addressHex, height) => {
    let result
    try {
      result = await send(createPayload({
        method: 'eth_listTransactions',
        params: [
          prefixHex(addressHex),
          height,
          undefined, // blockHeight,
          'asc'
        ]
      }))
    } catch (err) {
      if (/no transactions/i.test(err.message)) {
        debug(`no transactions found for address ${addressHex}`)
        return []
      }

      throw err
    }

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
      const height = Number(txInfo.blockNumber)
      blockHeight = Math.max(blockHeight, height)
      return {
        blockHeight,
        txId: unprefixHex(txInfo.hash),
        confirmations: blockHeight - height,
        from: {
          addresses: [txInfo.from].map(unprefixHex)
        },
        to: {
          addresses: [txInfo.to].map(unprefixHex)
        },
        data: unprefixHex(txInfo.input || '')
      }
    })

    return result
  }

  const blockchain = extend(new EventEmitter(), {
    network,
    close: stop,
    stop,
    start,
    info: requireReady(getLatestBlock),
    blocks: {
      latest: requireReady(getLatestBlock)
    },
    transactions: {
      get: requireReady(getTxs),
      propagate: requireReady(sendRawTx)
    },
    addresses: {
      transactions: requireReady(getTxsForAccounts),
      balance: requireReady(getBalance.bind(null, engine))
    }
  })

  return blockchain
}

const getBalance = async (engine, address) => {
  const send = getSend(engine)
  // balance in wei
  return await send(createPayload({
    method: 'eth_getBalance',
    params: [prefixHex(address), 'latest']
  }))
}

const createTransactor = ({ network, engine, wallet, privateKey }) => {
  const send = getSend(engine)
  const getGasPrice = pMemoize(() => send(createPayload({
    method: 'eth_gasPrice',
    params: []
  })), { maxAge: 60000 })

  const signAndSend = async ({
    to,
    data,
    gasPrice
    // gasPrice=gasPriceByPriority.mediumLow,
  }) => {
    // if not started
    engine.start()

    if (to.length !== 1) {
      throw new Error('only one recipient allowed')
    }

    to = to.map(normalizeTo)

    debug('sending transaction')
    if (!gasPrice) gasPrice = await getGasPrice()

    const params = pickNonNull({
      gas: GAS_FOR_TRANSFER,
      gasLimit: GAS_FOR_TRANSFER,
      gasPrice,
      from: wallet.getAddressString(),
      to: to[0].address,
      value: '0x0', // prefixHex(to.amount.toString(16)),
      // EIP 155 chainId - mainnet: 1, ropsten: 3, rinkeby: 54
      chainId: network.constants.chainId,
      data
    })

    const payload = createPayload({
      method: 'eth_sendTransaction',
      params: [params]
    })

    try {
      return {
        txId: await send(payload)
      }
    } catch (err) {
      if (isUnderpricedError(err)) {
        debug('attempting with 10% price increase')
        return signAndSend({
          to,
          data,
          gasPrice: gasPrice * 1.101 // 1.1 + an extra .001 for floating point math nonsense
        })
      }

      throw err
    }
  }

  wallet = getWallet({ wallet, privateKey })
  return {
    multipleRecipientsAllowed: false,
    send: signAndSend,
    start: engine.start.bind(engine),
    stop: engine.stop.bind(engine),
    close: engine.stop.bind(engine),
    balance: getBalance.bind(null, engine, wallet.getAddressString())
  }
}

function generateKey () {
  let key
  return {
    // lazy
    get pub () {
      if (key === undefined) {
        key = Wallet.generate(true)
      }
      return key.pubKey
    },
    get priv () {
      if (key === undefined) {
        key = Wallet.generate(true)
      }
      return key.privKey
    }
  }
}

function pubKeyToAddress (pub) {
  if (pub.length === 65) pub = pub.slice(1)

  const prefixed = Wallet.fromPublicKey(pub).getAddressString()
  return unprefixHex(prefixed)
}

function createEngine (opts) {
  let { rpcUrl, maxPriceInWei } = opts
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
    wallet = getWallet(opts)

    const walletProvider = new WalletSubprovider(wallet, opts)
    if (maxPriceInWei) {
      maxPriceInWei = new BN(maxPriceInWei)
      const { signTransaction } = walletProvider
      walletProvider.signTransaction = (txData, cb) => {
        const { gasPrice, gas, value } = txData
        // gas: "0x5208"
        // gasPrice: 19900000000
        // value: "0x1"
        const priceInWei = new BN(unhexint(gasPrice))
          .mul(new BN(unhexint(gas)))
          .add(new BN(unprefixHex(value)))

        if (priceInWei.cmp(maxPriceInWei) > 0) {
          return cb(new Error(`aborting, too expensive: ${priceInWei.toString()} wei`))
        }

        return signTransaction.call(walletProvider, txData, cb)
      }
    }

    engine.addProvider(walletProvider)
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
      personalRecoverSigner: opts.personalRecoverSigner
    })

    engine.addProvider(idmgmtSubprovider)
  }

  engine.addProvider(new GasPriceSubprovider())

  // data sources
  if (rpcUrl) {
    if (!opts.etherscan) {
      engine.addProvider(new TxListSubprovider({ rpcUrl }))
    }

    engine.addProvider(new RpcSubprovider({ rpcUrl }))
  }

  if (opts.etherscan) {
    let etherscanOpts = typeof opts.etherscan === 'boolean' ? {} : opts.etherscan
    etherscanOpts = clone(etherscanOpts, {
      https: true,
      network: opts.networkName
    })

    engine.addProvider(new EtherscanSubprovider(etherscanOpts))
  }

  if (opts.autostart !== false) {
    engine.start()
  }

  engine.setMaxListeners(Infinity)
  engine.once('block', () => {
    ENGINE_READY_MAP.set(engine, true)
  })

  return engine
}

const unprefixHex = hex => hex.indexOf('0x') === 0 ? hex.slice(2) : hex
const prefixHex = hex => hex.indexOf('0x') === 0 ? hex : '0x' + hex
const getWallet = ({ privateKey, wallet }) => wallet || Wallet.fromPrivateKey(privateKey)

const pickNonNull = obj => {
  const nonNull = {}
  for (const key in obj) {
    if (obj[key] != null) {
      nonNull[key] = obj[key]
    }
  }

  return nonNull
}

const isUnderpricedError = err => /underpriced/i.test(err.message)
const normalizeTo = ({ address, amount }) => ({
  address: prefixHex(address),
  amount
})

module.exports = {
  networks,
  createNetwork,
  createEngine,
  createTransactor,
  createBlockchainAPI,
  gasPriceByPriority
}

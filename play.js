const Wallet = require('ethereumjs-wallet')
const TestRPC = require('ethereumjs-testrpc')
// web3.setProvider(TestRPC.provider())

const privateKey = new Buffer('b7cf3de6543ef65d816ad5cd1ce725a3a6157a4af72c2045f4479f7680be1b3a', 'hex')
const wallet = Wallet.fromPrivateKey(privateKey)

const accounts = [
  {
    secretKey: '0x2633b8c23d965d0c7452afa5def69445cc9762d8eb4c78a724c63b9135e77a2a',
    balance: '0x0000000000000056bc75e2d63100000'
  },
  {
    secretKey: '0xd01e8fccfad7b0657a58645f0bcc4c89d4359bf21eb21b5391122752960cdd3e',
    balance: '0x0000000000000056bc75e2d63100000'
  }
]

// const rpcProvider = TestRPC.provider({
//   accounts
// })

const port = 8545
const constants = require('./networks').localtest
const rpcUrl = `http://localhost:${port}`
const server = TestRPC.server({ accounts, networkId: constants.chainId })

server.listen(port, function (err, blockchain) {
  // console.log(arguments)
})

const api = require('./api')({ rpcUrl, constants })

const privateKeys = accounts.map(account => new Buffer(account.secretKey.slice(2), 'hex'))
const addresses = privateKeys.map(key => Wallet.fromPrivateKey(key).getAddressString())
const blockchain = api.createBlockchainAPI()
const transactor = api.createTransactor({
  privateKey: privateKeys[0]
})

const pub = Wallet.fromPrivateKey(privateKeys[1]).getPublicKey()
// console.log(api.pubKeyToAddress(pub))

// blockchain.blocks.latest(console.log)

function sendTx (cb) {
  transactor.send({
    to: [{ address: addresses[1], amount: 1 }]
  }, function (err) {
    if (err) throw err

    cb()
  })
}

function checkTxs () {
  blockchain.addresses.transactions(addresses, function (err, result) {
    console.log(JSON.stringify(result, null, 2))
  })
}

sendTx(checkTxs)

// blockchain.transactions.get(['3c5084a3e2639d46369c02e18b0b91f92e26c40f2f10055c70d77e8ff1cf1a9e'], function (err, result) {
//   console.log(JSON.stringify(result, null, 2))
// })

process.on('uncaughtException', function (err) {
  console.log(err)
  process.exit(1)
})

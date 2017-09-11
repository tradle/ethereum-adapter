
# @tradle/ethereum-adapter

Ethereum network adapter for [@tradle/engine](https://github.com/tradle/engine)

## Usage

```js
const EthAdapter = require('@tradle/ethereum-adapter')
const network = EthAdapter.createNetwork({
  networkName: 'ropsten'
})

const privateKey = KEY_BUFFER
const node = tradle.node({
  // ...
  network,
  blockchain: network.createBlockchainAPI(),
  transactor: network.createTransactor({ privateKey })
  // ..
})
```

## Todo

to enable new version detection the deterministic address can be put in the data field. In bitcoin-adapter, it's put in a 2nd output address.

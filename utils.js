const { promisify } = require('bluebird')

const normalizeEngineError = (err, response) => {
  if (!err && response && response.error) {
    err = response.error
  }

  if (!(err instanceof Error)) {
    if (typeof err === 'object') err = JSON.stringify(err)
    if (typeof err === 'string') err = new Error(err)
  }

  return err
}

const getSend = engine => payload => new Promise((resolve, reject) => {
  engine.sendAsync(payload, (err, response) => {
    if (err) return reject(normalizeEngineError(err, response))

    resolve(response.result)
  })
})

const flatten = arr => arr.reduce((all, some) => all.concat(some), [])

module.exports = {
  getSend,
  promisify,
  flatten
}

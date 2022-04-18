const errorProps = ['message', 'code', 'stack']
const normalizeMessage = err => {
  if (typeof err.message === 'string') {
    return err.message
  }
  if (typeof err.stack === 'string' && err.stack.length > 0) {
    return err.stack.split('\n')[0]
  }
  if (err.code) {
    return `Error Code: ${err.code}`
  }
  return 'Unidentified Error'
}

const normalizeError = err => {
  if (err === undefined || err === null) {
    return new Error('Unidentified error response.')
  }
  if (err instanceof Error) {
    return err
  }
  if (typeof err === 'object') {
    const nonErrorProp = Object.keys(err).find(key => !errorProps.includes(key))
    if (nonErrorProp) {
      return new Error(JSON.stringify(err))
    }
    const result = new Error(normalizeMessage(err))
    if (err.code) {
      result.code = err.code
    }
    if (err.stack) {
      Object.defineProperty(result, 'stack', {
        value: err.stack
      })
    }
    return result
  }
  return new Error(String(err))
}

const normalizeEngineError = (err, response) => {
  if (err) {
    return normalizeError(err)
  }
  if (response && response.error) {
    return normalizeError(response.error)
  }
  return normalizeError(response)
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
  flatten
}

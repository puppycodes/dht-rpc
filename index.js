var udp = require('udp-request')
var crypto = require('crypto')
var KBucket = require('k-bucket')
var inherits = require('inherits')
var events = require('events')
var peers = require('ipv4-peers')
var bufferEquals = require('buffer-equals')
var collect = require('stream-collector')
var nodes = peers.idLength(32)
var messages = require('./messages')
var queryStream = require('./query-stream')

module.exports = DHT

function DHT (opts) {
  if (!(this instanceof DHT)) return new DHT(opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  var self = this

  this.concurrency = opts.concurrency || 16
  this.bootstrap = [].concat(opts.bootstrap || []).map(parseAddr)
  this.id = opts.id || crypto.randomBytes(32)
  this.ephemeral = !!opts.ephemeral
  this.nodes = new KBucket({localNodeId: this.id, arbiter: arbiter})
  this.nodes.on('ping', onnodeping)
  this.inflightQueries = 0

  this.socket = udp({
    socket: opts.socket,
    requestEncoding: messages.Request,
    responseEncoding: messages.Response
  })

  this.socket.on('request', onrequest)
  this.socket.on('response', onresponse)
  this.socket.on('close', onclose)

  this._queryId = this.ephemeral ? null : this.id
  this._bootstrapped = false
  this._pendingRequests = []
  this._tick = 0
  this._secrets = [crypto.randomBytes(32), crypto.randomBytes(32)]
  this._secretsInterval = setInterval(rotateSecrets, 5 * 60 * 1000)
  this._tickInterval = setInterval(tick, 5 * 1000)

  if (opts.nodes) {
    for (var i = 0; i < opts.nodes.length; i++) {
      this._addNode(opts.nodes[i].id, opts.nodes[i])
    }
  }

  process.nextTick(function () {
    self._bootstrap()
  })

  function rotateSecrets () {
    self._rotateSecrets()
  }

  function onrequest (request, peer) {
    self._onrequest(request, peer)
  }

  function onresponse (response, peer) {
    self._onresponse(response, peer)
  }

  function onnodeping (oldContacts, newContact) {
    self._onnodeping(oldContacts, newContact)
  }

  function onclose () {
    while (self._pendingRequests.length) {
      self._pendingRequests.shift().callback(new Error('Request cancelled'))
    }
    self.emit('close')
  }

  function tick () {
    self._tick++
    if ((self._tick & 7) === 0) self._pingSome()
  }
}

inherits(DHT, events.EventEmitter)

DHT.prototype.ready = function (cb) {
  if (this.bootstrapping) this.once('ready', cb)
  else cb()
}

DHT.prototype.query = function (query, opts, cb) {
  if (typeof opts === 'function') return this.query(query, null, opts)
  return collect(queryStream(this, query, opts), cb)
}

DHT.prototype.closest = function (query, opts, cb) {
  if (typeof opts === 'function') return this.closest(query, null, opts)
  if (!opts) opts = {}
  opts.token = true
  return collect(queryStream(this, query, opts), cb)
}

DHT.prototype._pingSome = function () {
  // console.log('ping some ...')
}

DHT.prototype._closestNodes = function (target, opts, cb) {
  var nodes = opts.nodes || opts.node

  if (nodes) {
    if (!Array.isArray(nodes)) nodes = [nodes]
    process.nextTick(function () {
      cb(null, nodes)
    })
    return null
  }

  var qs = this.get({
    command: '_find_node',
    target: target
  })

  qs.resume()
  qs.on('error', noop)
  qs.on('end', function () {
    cb(null, qs.closest)
  })

  return qs
}

DHT.prototype.holepunch = function (peer, referrer, cb) {
  this._holepunch(parseAddr(peer), parseAddr(referrer), cb)
}

DHT.prototype.ping = function (peer, cb) {
  this._ping(parseAddr(peer), function (err, res, peer) {
    if (err) return cb(err)
    var rinfo = decodePeer(res.value)
    if (!rinfo) return cb(new Error('Invalid pong'))
    cb(null, rinfo, {port: peer.port, host: peer.host, id: res.id})
  })
}

DHT.prototype.toArray = function () {
  return this.nodes.toArray()
}

DHT.prototype.destroy = function () {
  clearInterval(this._secretsInterval)
  clearInterval(this._tickInterval)
  this.socket.destroy()
}

DHT.prototype._rotateSecrets = function () {
  var secret = crypto.randomBytes(32)
  this._secrets[1] = this._secrets[0]
  this._secrets[0] = secret
}

DHT.prototype._bootstrap = function () {
  // TODO: run in the background
  // TODO: check stats, to determine wheather to rerun?
  var self = this

  if (!this.bootstrap.length) return process.nextTick(done)

  var backgroundCon = Math.min(self.concurrency, Math.max(2, Math.floor(self.concurrency / 8)))
  var qs = this.query({
    command: '_find_node',
    target: this.id
  })

  qs.on('data', update)

  qs.on('error', function (err) {
    self.emit('error', err)
  })

  qs.on('end', done)

  update()

  function done () {
    self._bootstrapped = true
    self.emit('ready')
  }

  function update () {
    qs._concurrency = self.inflightQueries === 1 ? self.concurrency : backgroundCon
  }
}

DHT.prototype._ping = function (peer, cb) {
  this._request({command: '_ping', id: this._queryId}, peer, false, cb)
}

DHT.prototype._holepunch = function (peer, referrer, cb) {
  this._request({command: '_ping', id: this._queryId, forwardRequest: encodePeer(peer)}, referrer, false, cb)
}

DHT.prototype._request = function (request, peer, important, cb) {
  if (this.socket.inflight >= this.concurrency || this._pendingRequests.length) {
    this._pendingRequests.push({request: request, peer: peer, callback: cb})
  } else {
    // console.log('sending', peer)
    this.socket.request(request, peer, cb)
  }
}

DHT.prototype._onrequest = function (request, peer) {
  if (validateId(request.id)) this._addNode(request.id, peer, request.roundtripToken)

  if (request.roundtripToken) {
    if (!bufferEquals(request.roundtripToken, this._token(peer, 0))) {
      if (!bufferEquals(request.roundtripToken, this._token(peer, 1))) {
        request.roundtripToken = null
      }
    }
  }

  if (request.forwardRequest) {
    this._forwardRequest(request, peer)
    return
  }

  if (request.forwardResponse) peer = this._forwardResponse(request, peer)

  switch (request.command) {
    case '_ping': return this._onping(request, peer)
    case '_find_node': return this._onfindnode(request, peer)
  }

  this._onquery(request, peer)
}

DHT.prototype._forwardResponse = function (request, peer) {
  if (request.command !== '_ping') return // only allow ping for now

  try {
    var from = peers.decode(request.forwardResponse)[0]
    if (!from) return
  } catch (err) {
    return
  }

  from.request = true
  from.tid = peer.tid

  return from
}

DHT.prototype._forwardRequest = function (request, peer) {
  if (request.command !== '_ping') return // only allow ping forwards right now

  try {
    var to = peers.decode(request.forwardRequest)[0]
    if (!to) return
  } catch (err) {
    return
  }

  this.emit('holepunch', peer, to)
  request.forwardRequest = null
  request.forwardResponse = encodePeer(peer)
  this.socket.forwardRequest(request, peer, to)
}

DHT.prototype._onquery = function (request, peer) {
  var self = this
  var query = {
    node: {
      id: request.id,
      port: peer.port,
      host: peer.host
    },
    command: request.command,
    target: request.target,
    value: request.value,
    roundtripToken: request.roundtripToken
  }

  var method = request.roundtripToken ? 'closest' : 'query'

  if (!this.emit(method + ':' + request.command, query, callback) && !this.emit(method, query, callback)) callback()

  function callback (err, value) {
    if (err) return

    var res = {
      id: self._queryId,
      value: value || null,
      nodes: nodes.encode(self.nodes.closest(request.target, 20)),
      roundtripToken: self._token(peer, 0)
    }

    self.socket.response(res, peer)
  }
}

DHT.prototype._onresponse = function (response, peer) {
  if (validateId(response.id)) this._addNode(response.id, peer, response.roundtripToken)

  while (this.socket.inflight < this.concurrency && this._pendingRequests.length) {
    var next = this._pendingRequests.shift()
    this.socket.request(next.request, next.peer, next.callback)
  }
}

DHT.prototype._onping = function (request, peer) {
  var res = {
    id: this._queryId,
    value: encodePeer(peer),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onfindnode = function (request, peer) {
  if (!validateId(request.target)) return

  var res = {
    id: this._queryId,
    nodes: nodes.encode(this.nodes.closest(request.target, 20)),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onnodeping = function (oldContacts, newContact) {
  if (!this._bootstrapped) return // bootstrapping, we've recently pinged all nodes

  var reping = []

  for (var i = 0; i < oldContacts.length; i++) {
    var old = oldContacts[i]

    if (this._tick - old.tick < 3) { // less than 10s since we talked to this peer ...
      this.nodes.add(oldContacts[i])
      continue
    }

    reping.push(old)
  }

  if (reping.length) this._reping(reping, newContact)
}

DHT.prototype._reping = function (oldContacts, newContact) {
  var self = this
  var next = null

  ping()

  function ping () {
    next = oldContacts.shift()
    if (next) self._request({command: '_ping', id: self._queryId}, next, true, afterPing)
  }

  function afterPing (err) {
    if (!err) return ping()

    self.nodes.remove(next.id)
    self.nodes.add(newContact)
  }
}

DHT.prototype._token = function (peer, i) {
  return crypto.createHash('sha256').update(this._secrets[i]).update(peer.host).digest()
}

DHT.prototype._addNode = function (id, peer, token) {
  if (bufferEquals(id, this.id)) return
  this.nodes.add({
    id: id,
    port: peer.port,
    host: peer.host,
    roundtripToken: token,
    tick: this._tick
  })
}

DHT.prototype.listen = function (port, cb) {
  this.socket.listen(port, cb)
}

function noop () {}

function encodePeer (peer) {
  return peer && peers.encode([peer])
}

function decodePeer (buf) {
  try {
    return buf && peers.decode(buf)[0]
  } catch (err) {
    return null
  }
}

function parseAddr (addr) {
  if (typeof addr === 'object' && addr) return addr
  if (typeof addr === 'number') return parseAddr(':' + addr)
  if (addr[0] === ':') return parseAddr('127.0.0.1' + addr)
  return {port: Number(addr.split(':')[1] || 3282), host: addr.split(':')[0]}
}

function validateId (id) {
  return id && id.length === 32
}

function arbiter (incumbant, candidate) {
  return candidate
}

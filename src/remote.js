// Remote access to a server.
// - We never send binary data.
// - We use the W3C interface for node and browser compatibility:
//   http://www.w3.org/TR/websockets/#the-websocket-interface
//
// This class is intended for both browser and Node.js use.
//
// This class is designed to work via peer protocol via either the public or
// private WebSocket interfaces. The JavaScript class for the peer protocol
// has not yet been implemented. However, this class has been designed for it
// to be a very simple drop option.
//
// YYY Will later provide js/network.js which will transparently use multiple
// instances of this class for network access.

var EventEmitter = require('events').EventEmitter;
var util         = require('util');
var LRU          = require('lru-cache');
var Request      = require('./request').Request;
var Server       = require('./server').Server;
var Amount       = require('./amount').Amount;
var Currency     = require('./currency').Currency;
var UInt160      = require('./uint160').UInt160;
var Transaction  = require('./transaction').Transaction;
var Account      = require('./account').Account;
var Meta         = require('./meta').Meta;
var OrderBook    = require('./orderbook').OrderBook;
var PathFind     = require('./pathfind').PathFind;
var StellarError  = require('./stellarerror').StellarError;
var utils        = require('./utils');
var config       = require('./config');

/**
 *    Interface to manage the connection to a Stellar server.
 *
 *    This implementation uses WebSockets.
 *
 *    Keys for opts:
 *
 *      max_listeners      : Set maxListeners for remote; prevents EventEmitter warnings
 *      connection_offset  : Connect to remote servers on supplied interval (in seconds)
 *      trusted            : truthy, if remote is trusted
 *      max_fee            : Maximum acceptable transaction fee
 *      fee_cushion        : ESTRa fee multiplier to account for async fee changes.
 *      servers            : Array of server objects with the following form
 *      canonical_signing  : Signatures should be canonicalized and the "canonical" flag set
 *
 *         {
 *              host:    <string>
 *            , port:    <number>
 *            , secure:  <boolean>
 *         }
 *
 *    Events:
 *      'connect'
 *      'disconnect'
 *      'state':
 *      - 'online'        : Connected and subscribed.
 *      - 'offline'       : Not subscribed or not connected.
 *      'subscribed'      : This indicates stand-alone is available.
 *
 *    Server events:
 *      'ledger_closed'   : A good indicate of ready to serve.
 *      'transaction'     : Transactions we receive based on current subscriptions.
 *      'transaction_all' : Listening triggers a subscribe to all transactions
 *                          globally in the network.
 *
 *    @param opts      Connection options.
 */

function Remote(opts) {
  EventEmitter.call(this);

  var self = this;
  var opts = opts || { };

  this.trusted = Boolean(opts.trusted);
  this.state = 'offline'; // 'online', 'offline'
  this._server_fatal = false; // True, if we know server exited.

  this.local_sequence = Boolean(opts.local_sequence); // Locally track sequence numbers
  this.local_fee = (typeof opts.local_fee === 'boolean') ? opts.local_fee : true;// Locally set fees
  this.local_signing = (typeof opts.local_signing === 'boolean') ? opts.local_signing : true;
  this.canonical_signing = (typeof opts.canonical_signing === 'boolean') ? opts.canonical_signing : true;

  this.fee_cushion = (typeof opts.fee_cushion === 'number') ? opts.fee_cushion : 1.2;
  this.max_fee = (typeof opts.max_fee === 'number') ? opts.max_fee : Infinity;

  this._ledger_current_index = void(0);
  this._ledger_hash = void(0);
  this._ledger_time = void(0);

  this._stand_alone = void(0);
  this._testnet = void(0);

  this._transaction_subs = 0;
  this._connection_count = 0;
  this._connected = false;

  this._connection_offset = 1000 * (typeof opts.connection_offset === 'number' ? opts.connection_offset : 0);
  this._submission_timeout = 1000 * (typeof opts.submission_timeout === 'number' ? opts.submission_timeout : 10);

  this._received_tx = LRU({ max: 100 });
  this._cur_path_find = null;

  // Local signing implies local fees and sequences
  if (this.local_signing) {
    this.local_sequence = true;
    this.local_fee = true;
  }

  this._servers = [ ];
  this._primary_server = void(0);

  // Cache information for accounts.
  // DEPRECATED, will be removed
  // Consider sequence numbers stable if you know you're not generating bad transactions.
  // Otherwise, clear it to have it automatically refreshed from the network.
  // account : { seq : __ }
  this.accounts = { };

  // Account objects by AccountId.
  this._accounts = { };

  // OrderBook objects
  this._books = { };

  // Secrets that we know about.
  // Secrets can be set by calling set_secret(account, secret).
  // account : secret
  this.secrets = { };

  // Cache for various ledgers.
  // XXX Clear when ledger advances.
  this.ledgers = {
    current : {
      account_root : { }
    }
  };

  if (typeof this._connection_offset !== 'number') {
    throw new TypeError('Remote "connection_offset" configuration is not a Number');
  }

  if (typeof this._submission_timeout !== 'number') {
    throw new TypeError('Remote "submission_timeout" configuration is not a Number');
  }

  if (typeof this.max_fee !== 'number') {
    throw new TypeError('Remote "max_fee" configuration is not a Number');
  }

  if (typeof this.fee_cushion !== 'number') {
    throw new TypeError('Remote "fee_cushion" configuration is not a Number');
  }

  if (typeof this.local_signing !== 'boolean') {
    throw new TypeError('Remote "local_signing" configuration is not a Boolean');
  }

  if (typeof this.local_fee !== 'boolean') {
    throw new TypeError('Remote "local_fee" configuration is not a Boolean');
  }

  if (typeof this.local_sequence !== 'boolean') {
    throw new TypeError('Remote "local_sequence" configuration is not a Boolean');
  }

  if (!/^(undefined|number)$/.test(typeof opts.ping)) {
    throw new TypeError('Remote "ping" configuration is not a Number');
  }

  if (!/^(undefined|object)$/.test(typeof opts.storage)) {
    throw new TypeError('Remote "storage" configuration is not an Object');
  }

  // Fallback for previous API
  if (!opts.hasOwnProperty('servers') && opts.websocket_ip) {
    opts.servers = [
      {
        host:     opts.websocket_ip,
        port:     opts.websocket_port,
        secure:   opts.websocket_ssl,
        trusted:  opts.trusted
      }
    ];
  }

  (opts.servers || []).forEach(function(server) {
    var pool = Number(server.pool) || 1;
    while (pool--) {
      self.addServer(server);
    };
  });

  // This is used to remove Node EventEmitter warnings
  var maxListeners = opts.maxListeners || opts.max_listeners || 0;

  this._servers.concat(this).forEach(function(emitter) {
    if (emitter instanceof EventEmitter) {
      emitter.setMaxListeners(maxListeners);
    }
  });

  function listenerAdded(type, listener) {
    if (type === 'transaction_all') {
      if (!self._transaction_subs && self._connected) {
        self.requestSubscribe('transactions').request();
      }
      self._transaction_subs += 1;
    }
  };

  this.on('newListener', listenerAdded);

  function listenerRemoved(type, listener) {
    if (type === 'transaction_all') {
      self._transaction_subs -= 1;
      if (!self._transaction_subs && self._connected) {
        self.requestUnsubscribe('transactions').request();
      }
    }
  };

  this.on('removeListener', listenerRemoved);

  if (opts.storage) {
    this.storage = opts.storage;
    this.once('connect', this.getPendingTransactions.bind(this));
  }

  function pingServers() {
    var pingRequest = self.requestPing();
    pingRequest.on('error', function(){});
    pingRequest.broadcast();
  };

  if (opts.ping) {
    this.once('connect', function() {
      self._pingInterval = setInterval(pingServers, opts.ping * 1000);
    });
  }
};

util.inherits(Remote, EventEmitter);

// Flags for ledger entries. In support of account_root().
Remote.flags = {
  // Account Root
  account_root: {
    PasswordSpent:   0x00010000, // True, if password set fee is spent.
    RequireDestTag:  0x00020000, // True, to require a DestinationTag for payments.
    RequireAuth:     0x00040000, // True, to require a authorization to hold IOUs.
    DisallowXRP:     0x00080000, // True, to disallow sending XRP.
    DisableMaster:   0x00100000  // True, force regular key.
  },

  // Offer
  offer: {
    Passive:         0x00010000,
    Sell:            0x00020000  // True, offer was placed as a sell.
  },

  // Stellar State
  state: {
    LowReserve:      0x00010000, // True, if entry counts toward reserve.
    HighReserve:     0x00020000,
    LowAuth:         0x00040000,
    HighAuth:        0x00080000,
    LowNoStellar:     0x00100000,
    HighNoStellar:    0x00200000
  }
};

Remote.from_config = function(obj) {
  var serverConfig = (typeof obj === 'string') ? config.servers[obj] : obj;
  var remote = new Remote(serverConfig);

  function initializeAccount(account) {
    var accountInfo = config.accounts[account];
    if (typeof accountInfo === 'object') {
      if (accountInfo.secret) {
        // Index by nickname
        remote.setSecret(account, accountInfo.secret);
        // Index by account ID
        remote.setSecret(accountInfo.account, accountInfo.secret);
      }
    }
  };

  if (config.accounts) {
    Object.keys(config.accounts).forEach(initializeAccount);
  }

  return remote;
};

/**
 * Check that server message is valid
 *
 * @param {Object} message
 */

Remote.isValidMessage = function(message) {
  return (typeof message === 'object')
      && (typeof message.type === 'string');
};

/**
 * Check that server message contains valid
 * ledger data
 *
 * @param {Object} message
 */

Remote.isValidLedgerData = function(message) {
  return (typeof message === 'object')
    && (typeof message.fee_base === 'number')
    && (typeof message.fee_ref === 'number')
    && (typeof message.fee_base === 'number')
    && (typeof message.ledger_hash === 'string')
    && (typeof message.ledger_index === 'number')
    && (typeof message.ledger_time === 'number')
    && (typeof message.reserve_base === 'number')
    && (typeof message.reserve_inc === 'number')
    && (typeof message.txn_count === 'number');
};

/**
 * Check that server message contains valid
 * load status data
 *
 * @param {Object} message
 */

Remote.isValidLoadStatus = function(message) {
  return (typeof message.load_base === 'number')
      && (typeof message.load_factor === 'number');
};

/**
 * Set the emitted state: 'online' or 'offline'
 *
 * @param {String} state
 */

Remote.prototype._setState = function(state) {
  if (this.state !== state) {
    this.state = state;
    this.emit('state', state);

    switch (state) {
      case 'online':
        this._online_state = 'open';
        this._connected = true;
        this.emit('connect');
        this.emit('connected');
        break;
      case 'offline':
        this._online_state = 'closed';
        this._connected = false;
        this.emit('disconnect');
        this.emit('disconnected');
        break;
    }
  }
};

/**
 * Inform remote that the remote server is not comming back.
 */

Remote.prototype.setServerFatal = function() {
  this._server_fatal = true;
};

/**
 * Store a secret - allows the Remote to automatically fill 
 * out auth information.
 *
 * @param {String} account
 * @param {String} secret
 */

Remote.prototype.setSecret = function(account, secret) {
  this.secrets[account] = secret;
};

Remote.prototype.getPendingTransactions = function() {
  var self = this;

  function resubmitTransaction(tx) {
    if (typeof tx !== 'object') {
      return;
    }

    var transaction = self.transaction();
    transaction.parseJson(tx.tx_json);
    transaction.clientID(tx.clientID);
    Object.keys(tx).forEach(function(prop) {
      switch (prop) {
        case 'secret':
          case 'submittedIDs':
          case 'submitIndex':
          transaction[prop] = tx[prop];
        break;
      }
    });

    transaction.submit();
  };

  this.storage.getPendingTransactions(function(err, transactions) {
    if (!err && Array.isArray(transactions)) {
      transactions.forEach(resubmitTransaction);
    }
  });
};

Remote.prototype.addServer = function(opts) {
  var self = this;

  var server = new Server(this, opts);

  function serverMessage(data) {
    self._handleMessage(data, server);
  };

  server.on('message', serverMessage);

  function serverConnect() {
    self._connection_count += 1;

    if (opts.primary) {
      self._setPrimaryServer(server);
    }
    if (self._connection_count === 1) {
      self._setState('online');
    }
    if (self._connection_count === self._servers.length) {
      self.emit('ready');
    }
  };

  server.on('connect', serverConnect);

  function serverDisconnect() {
    self._connection_count--;
    if (self._connection_count === 0) {
      self._setState('offline');
    }
  };

  server.on('disconnect', serverDisconnect);

  this._servers.push(server);

  return this;
};

/**
 * Connect to the Stellar network.
 *
 * @param {Function} callback
 * @api public
 */

Remote.prototype.connect = function(online) {
  if (!this._servers.length) {
    throw new Error('No servers available.');
  }

  switch (typeof online) {
    case 'undefined':
      break;
    case 'function':
      this.once('connect', online);
      break;
    default:
      // Downwards compatibility
      if (!Boolean(online)) {
        return this.disconnect();
      }
  }

  var self = this;

  ;(function nextServer(i) {
    self._servers[i].connect();
    var next = nextServer.bind(this, ++i);
    if (i < self._servers.length) {
      setTimeout(next, self._connection_offset);
    }
  })(0);

  return this;
};

/**
 * Disconnect from the Stellar network.
 *
 * @param {Function} callback
 * @api public
 */

Remote.prototype.disconnect = function(callback) {
  if (!this._servers.length) {
    throw new Error('No servers available, not disconnecting');
  }

  if (typeof callback === 'function') {
    this.once('disconnect', callback);
  }

  this._servers.forEach(function(server) {
    server.disconnect();
  });

  this._set_state('offline');

  return this;
};

/**
 * Handle server message. Server messages are proxied to
 * the Remote, such that global events can be handled
 *
 * It is possible for messages to be dispatched after the
 * connection is closed.
 *
 * @param {JSON} message
 * @param {Server} server
 */

Remote.prototype._handleMessage = function(message, server) {
  var self = this;

  try {
    message = JSON.parse(message);
  } catch (e) {
  }

  if (!Remote.isValidMessage(message)) {
    // Unexpected response from remote.
    this.emit('error', new StellarError('remoteUnexpected', 'Unexpected response from remote'));
    return;
  }

  switch (message.type) {
    case 'ledgerClosed':
      this._handleLedgerClosed(message);
      break;
    case 'serverStatus':
      this._handleServerStatus(message);
      break;
    case 'transaction':
      this._handleTransaction(message);
      break;
    case 'find_path':
      this._handlePathFind(message);
      break;
    default:
      break;
  }
};

/**
 * Handle server ledger_closed event
 *
 * @param {Object} message
 */

Remote.prototype._handleLedgerClosed = function(message) {
  var self = this;

  // XXX If not trusted, need to verify we consider ledger closed.
  // XXX Also need to consider a slow server or out of order response.
  // XXX Be more defensive fields could be missing or of wrong type.
  // YYY Might want to do some cache management.
  if (!Remote.isValidLedgerData(message)) {
    return;
  }

  var ledgerAdvanced = message.ledger_index >= this._ledger_current_index;

  if (ledgerAdvanced) {
    this._ledger_time = message.ledger_time;
    this._ledger_hash = message.ledger_hash;
    this._ledger_current_index = message.ledger_index + 1;
    this.emit('ledger_closed', message);
  }
};

/**
 * Handle server server_status event
 *
 * @param {Object} message
 */

Remote.prototype._handleServerStatus = function(message) {
  this.emit('server_status', message);
};

/**
 * Handle server transaction event
 *
 * @param {Object} message
 */

Remote.prototype._handleTransaction = function(message) {
  var self = this;

  // XXX If not trusted, need proof.

  // De-duplicate transactions
  var transactionHash = message.transaction.hash;

  if (this._received_tx.get(transactionHash)) {
    return;
  }

  if (message.validated) {
    this._received_tx.set(transactionHash, true);
  }

  function notify(el) {
    var item = this[el];
    if (item && typeof item.notify === 'function') {
      item.notify(message);
    }
  };

  var metadata = message.meta || message.metadata;

  if (metadata) {
    // Process metadata
    message.mmeta = new Meta(metadata);

    // Pass the event on to any related Account objects
    var affectedAccounts = message.mmeta.getAffectedAccounts();
    affectedAccounts.forEach(notify.bind(this._accounts));

    // Pass the event on to any related OrderBooks
    var affectedBooks = message.mmeta.getAffectedBooks();
    affectedBooks.forEach(notify.bind(this._books));
  } else {
    // Transaction could be from proposed transaction stream
    [ 'Account', 'Destination' ].forEach(function(prop) {
      notify.call(self._accounts, message.transaction[prop]);
    });
  }

  this.emit('transaction', message);
  this.emit('transaction_all', message);
};

/**
 * Handle server find_path event
 *
 * @param {Object} message
 */

Remote.prototype._handlePathFind = function(message) {
  var self = this;

  // Pass the event to the currently open PathFind object
  if (this._cur_path_find) {
    this._cur_path_find.notify_update(message);
  }

  this.emit('path_find_all', message);
};

/**
 * Returns the current ledger hash
 *
 * @return {String} ledger hash
 */

Remote.prototype.getLedgerHash = function() {
  return this._ledger_hash;
};

/**
 * Set primary server. Primary server will be selected
 * to handle requested regardless of its internally-tracked
 * priority score
 *
 * @param {Server} server
 */

Remote.prototype._setPrimaryServer =
Remote.prototype.setPrimaryServer = function(server) {
  if (this._primary_server) {
    this._primary_server._primary = false;
  }
  this._primary_server = server;
  this._primary_server._primary = true;
};

/**
 * Select a server to handle a request. Servers are
 * automatically prioritized
 */

Remote.prototype._getServer =
Remote.prototype.getServer = function() {
  if (this._primary_server && this._primary_server._connected) {
    return this._primary_server;
  }

  function sortByScore(a, b) {
    var aScore = a._score + a._fee;
    var bScore = b._score + b._fee;
    if (aScore > bScore) {
      return 1;
    } else if (aScore < bScore) {
      return -1;
    } else {
      return 0;
    }
  };

  // Sort servers by score
  this._servers.sort(sortByScore);

  var index = 0;
  var server = this._servers[index];

  while (!server._connected) {
    server = this._servers[++index];
  }

  return server;
};

/**
 * Send a request. This method is called internally by Request
 * objects. Each Request contains a reference to Remote, and
 * Request.request calls Request.remote.request
 *
 * @param {Request} request
 */

Remote.prototype.request = function(request) {
  if (typeof request === 'string') {
    if (!/^request_/.test(request)) {
      request = 'request_' + request;
    }
    if (typeof this[request] === 'function') {
      var args = Array.prototype.slice.call(arguments, 1);
      return this[request].apply(this, args);
    } else {
      throw new Error('Command does not exist: ' + request);
    }
  }

  if (!(request instanceof Request)) {
    throw new Error('Argument is not a Request');
  }

  if (!this._servers.length) {
    request.emit('error', new Error('No servers available'));
  } else if (!this._connected) {
    this.once('connect', this.request.bind(this, request));
  } else if (request.server === null) {
    request.emit('error', new Error('Server does not exist'));
  } else {
    var server = request.server || this.getServer();
    if (server) {
      server._request(request);
    } else {
      request.emit('error', new Error('No servers available'));
    }
  }
};

/**
 * Request ping
 *
 * @param [String] server host
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.ping  =
Remote.prototype.requestPing = function(host, callback) {
  var request = new Request(this, 'ping');

  switch (typeof host) {
    case 'function':
      callback = host;
      break;
    case 'string':
      request.setServer(host);
      break;
  }

  var then = Date.now();

  request.once('success', function() {
    request.emit('pong', Date.now() - then);
  });

  request.callback(callback, 'pong');

  return request;
};

/**
 * Request server_info
 *
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestServerInfo = function(callback) {
  return new Request(this, 'server_info').callback(callback);
};

/**
 * Request ledger
 *
 * @return {Request} request
 */

Remote.prototype.requestLedger = function(ledger, options, callback) {
  // XXX This is a bad command. Some variants don't scale.
  // XXX Require the server to be trusted.
  //utils.assert(this.trusted);

  var request = new Request(this, 'ledger');

  if (ledger) {
    // DEPRECATED: use .ledger_hash() or .ledger_index()
    //console.log('requestLedger: ledger parameter is deprecated');
    request.message.ledger = ledger;
  }

  switch (typeof options) {
    case 'object':
      Object.keys(options).forEach(function(o) {
        switch (o) {
          case 'full':
          case 'expand':
          case 'transactions':
          case 'accounts':
            request.message[o] = true;
            break;
        }
      }, options);
      break;

    case 'function':
      callback = options;
      options = void(0);
      break;

    default:
      //DEPRECATED
      request.message.full = true;
      break;
  }

  request.callback(callback);

  return request;
};

/**
 * Request ledger_closed
 *
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestLedgerClosed =
Remote.prototype.requestLedgerHash = function(callback) {
  //utils.assert(this.trusted);   // If not trusted, need to check proof.
  return new Request(this, 'ledger_closed').callback(callback);
};

/**
 * Request ledger_header
 *
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestLedgerHeader = function(callback) {
  return new Request(this, 'ledger_header').callback(callback);
};

/**
 * Request ledger_current
 *
 * Get the current proposed ledger entry. May be closed (and revised)
 * at any time (even before returning).
 *
 * Only for unit testing.
 *
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestLedgerCurrent = function(callback) {
  return new Request(this, 'ledger_current').callback(callback);
};

/**
 * Request ledger_entry
 *
 * @param [String] type
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestLedgerEntry = function(type, callback) {
  //utils.assert(this.trusted);   // If not trusted, need to check proof, maybe talk packet protocol.

  var self = this;
  var request = new Request(this, 'ledger_entry');

  if (typeof type === 'function') {
    callback = type;
  }

  // Transparent caching. When .request() is invoked, look in the Remote object for the result.
  // If not found, listen, cache result, and emit it.
  //
  // Transparent caching:
  if (type === 'account_root') {
    request.requestDefault = request.request;

    request.request = function() {                        // Intercept default request.
      var bDefault  = true;
      // .self = Remote
      // this = Request

      // console.log('requestLedgerEntry: caught');

      //if (self._ledger_hash) {
        // A specific ledger is requested.
        // XXX Add caching.
        // else if (req.ledger_index)
        // else if ('stellar_state' === request.type)         // YYY Could be cached per ledger.
      //}

      if (!self._ledger_hash && type === 'account_root') {
        var cache = self.ledgers.current.account_root;

        if (!cache) {
          cache = self.ledgers.current.account_root = {};
        }

        var node = self.ledgers.current.account_root[request.message.account_root];

        if (node) {
          // Emulate fetch of ledger entry.
          // console.log('requestLedgerEntry: emulating');
          // YYY Missing lots of fields.
          request.emit('success', { node: node });
          bDefault  = false;
        } else { // Was not cached.
          // XXX Only allow with trusted mode.  Must sync response with advance.
          switch (type) {
            case 'account_root':
              request.once('success', function(message) {
                // Cache node.
                // console.log('requestLedgerEntry: caching');
                self.ledgers.current.account_root[message.node.Account] = message.node;
              });
              break;

            default:
              // This type not cached.
              // console.log('requestLedgerEntry: non-cached type');
          }
        }
      }

      if (bDefault) {
        // console.log('requestLedgerEntry: invoking');
        request.requestDefault();
      }
    };
  }

  request.callback(callback);

  return request;
};

/**
 * Request subscribe
 *
 * @param {Array} streams
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestSubscribe = function(streams, callback) {
  var request = new Request(this, 'subscribe');

  if (streams) {
    request.message.streams = Array.isArray(streams) ? streams : [ streams ];
  }

  request.callback(callback);

  return request;
};

/**
 * Request usubscribe
 *
 * @param {Array} streams
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestUnsubscribe = function(streams, callback) {
  var request = new Request(this, 'unsubscribe');

  if (streams) {
    request.message.streams = Array.isArray(streams) ? streams : [ streams ];
  }

  request.callback(callback);

  return request;
};

/**
 * Request transaction_entry
 *
 * @param {String} transaction hash
 * @param {String|Number} ledger hash or sequence
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestTransactionEntry = function(hash, ledgerHash, callback) {
  //// If not trusted, need to check proof, maybe talk packet protocol.
  //utils.assert(this.trusted);
  var request = new Request(this, 'transaction_entry');

  request.txHash(hash);

  switch (typeof ledgerHash) {
    case 'string':
    case 'number':
      request.ledgerSelect(ledgerHash);
      break;

    case 'undefined':
    case 'function':
      request.ledgerIndex('validated');
      callback = ledgerHash;
      break;

    default:
      throw new Error('Invalid ledger_hash type');
  }

  request.callback(callback);

  return request;
};

/**
 * Request tx
 *
 * @param {String} transaction hash
 * @param [Function] callback
 * @return {Request} request
 */

Remote.prototype.requestTransaction =
Remote.prototype.requestTx = function(hash, callback) {
  var request = new Request(this, 'tx');

  request.message.transaction = hash;
  request.callback(callback);

  return request;
};

/**
 * Account request abstraction
 *
 * @api private
 */

Remote.accountRequest = function(type, account, accountIndex, ledger, peer, callback) {
  if (typeof account === 'object') {
    var options  = account;
    callback     = accountIndex;
    ledger       = options.ledger;
    accountIndex = options.account_index || options.accountIndex;
    account      = options.accountID || options.account;
    peer         = options.peer;
  }

  var lastArg = arguments[arguments.length - 1];

  if (typeof lastArg === 'function') {
    callback = lastArg;
  }

  var request = new Request(this, type);
  var account = UInt160.json_rewrite(account);

  request.message.ident   = account; //DEPRECATED;
  request.message.account = account;

  if (typeof accountIndex === 'number') {
    request.message.index = accountIndex;
  }

  if (!/^(undefined|function)$/.test(typeof ledger)) {
    request.ledgerChoose(ledger);
  }

  if (!/^(undefined|function)$/.test(typeof peer)) {
    request.message.peer = UInt160.json_rewrite(peer);
  }

  request.callback(callback);

  return request;
};

/**
 * Request account_info
 *
 * @param {String} stellar address
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountInfo = function(account, callback) {
  var args = Array.prototype.concat.apply(['account_info'], arguments);
  return Remote.accountRequest.apply(this, args);
};

/**
 * Request account_currencies
 *
 * @param {String} stellar address
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountCurrencies = function(account, callback) {
  var args = Array.prototype.concat.apply(['account_currencies'], arguments);
  return Remote.accountRequest.apply(this, args);
};

/**
 * Request account_lines
 *
 * @param {String} stellar address
 * @param {Number] sub-account index
 * @param [String|Number] ledger
 * @param [String] peer
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountLines = function(account, accountIndex, ledger, peer, callback) {
  // XXX Does this require the server to be trusted?
  //utils.assert(this.trusted);
  var args = Array.prototype.concat.apply(['account_lines'], arguments);
  return Remote.accountRequest.apply(this, args);
};

/**
 * Request account_offers
 *
 * @param {String} stellar address
 * @param {Number] sub-account index
 * @param [String|Number] ledger
 * @param [String] peer
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountOffers = function(account, accountIndex, ledger, callback) {
  var args = Array.prototype.concat.apply(['account_offers'], arguments);
  return Remote.accountRequest.apply(this, args);
};


/**
 * Request account_tx
 *
 * @param {Object} options
 *
 *    @param {String} account
 *    @param [Number] ledger_index_min defaults to -1 if ledger_index_max is specified.
 *    @param [Number] ledger_index_max defaults to -1 if ledger_index_min is specified.
 *    @param [Boolean] binary, defaults to false
 *    @param [Boolean] parseBinary, defaults to true
 *    @param [Boolean] count, defaults to false
 *    @param [Boolean] descending, defaults to false
 *    @param [Number] offset, defaults to 0
 *    @param [Number] limit
 *
 * @param [Function] filter
 * @param [Function] map
 * @param [Function] reduce
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountTransactions =
Remote.prototype.requestAccountTx = function(options, callback) {
  // XXX Does this require the server to be trusted?
  //utils.assert(this.trusted);

  var request = new Request(this, 'account_tx');

  if (options.min_ledger !== void(0)) {
    options.ledger_index_min = options.min_ledger;
  }

  if (options.max_ledger !== void(0)) {
    options.ledger_index_max = options.max_ledger;
  }

  Object.keys(options).forEach(function(o) {
    switch (o) {
      case 'account':
      case 'ledger_index_min':  //earliest
      case 'ledger_index_max':  //latest
      case 'binary':            //false
      case 'count':             //false
      case 'descending':        //false
      case 'offset':            //0
      case 'limit':

      //extended account_tx
      case 'forward':           //false
      case 'marker':
        request.message[o] = this[o];
      break;
    }
  }, options);

  function propertiesFilter(obj, transaction) {
    var properties = Object.keys(obj);
    return function(transaction) {
      var result = properties.every(function(property) {
        return transaction.tx[property] === obj[property];
      });
      return result;
    };
  };

  var SerializedObject = require('./serializedobject').SerializedObject;

  function parseBinaryTransaction(transaction) {
    var tx = { validated: transaction.validated };
    tx.meta = new SerializedObject(transaction.meta).to_json();
    tx.tx = new SerializedObject(transaction.tx_blob).to_json();
    tx.tx.ledger_index = transaction.ledger_index;
    tx.tx.hash = Transaction.from_json(tx.tx).hash();
    return tx;
  };

  function accountTxFilter(fn) {
    if (typeof fn !== 'function') {
      throw new Error('Missing filter function');
    }

    var self = this;

    function filterHandler() {
      var listeners = self.listeners('success');

      self.removeAllListeners('success');

      self.once('success', function(res) {
        if (options.parseBinary) {
          res.transactions = res.transactions.map(parseBinaryTransaction);
        }

        if (fn !== Boolean) {
          res.transactions = res.transactions.filter(fn);
        }

        if (typeof options.map === 'function') {
          res.transactions = res.transactions.map(options.map);
        }

        if (typeof options.reduce === 'function') {
          res.transactions = res.transactions.reduce(options.reduce);
        }

        if (typeof options.pluck === 'string') {
          res = res[options.pluck];
        }

        listeners.forEach(function(listener) {
          listener.call(self, res);
        });
      });
    };

    this.once('request', filterHandler);

    return this;
  };

  request.filter = accountTxFilter;

  if (typeof options.parseBinary !== 'boolean') {
    options.parseBinary = true;
  }

  if (options.binary || (options.map || options.reduce)) {
    options.filter = options.filter || Boolean;
  }

  if (options.filter) {
    switch (options.filter) {
      case 'inbound':
        request.filter(propertiesFilter({ Destination: options.account }));
        break;
      case 'outbound':
        request.filter(propertiesFilter({ Account: options.account }));
        break;
      default:
        if (typeof options.filter === 'object') {
          options.filter = propertiesFilter(options.filter);
        }

        request.filter(options.filter);
    }
  }

  request.callback(callback);

  return request;
};

/**
 * Request the overall transaction history.
 *
 * Returns a list of transactions that happened recently on the network. The
 * default number of transactions to be returned is 20.
 *
 * @param [Number] start
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestTxHistory = function(start, callback) {
  // XXX Does this require the server to be trusted?
  //utils.assert(this.trusted);

  var request = new Request(this, 'tx_history');

  request.message.start = start;
  request.callback(callback);

  return request;
};

/**
 * Request book_offers
 *
 * @param {Object} gets
 * @param {Object} pays
 * @param {String} taker
 * @param [Function] calback
 * @return {Request}
 */

Remote.prototype.requestBookOffers = function(gets, pays, taker, callback) {
  if (gets.hasOwnProperty('pays')) {
    var options = gets;
    callback = pays;
    taker = options.taker;
    pays = options.pays;
    gets = options.gets;
  }

  var lastArg = arguments[arguments.length - 1];

  if (typeof lastArg === 'function') {
    callback = lastArg;
  }

  var request = new Request(this, 'book_offers');

  request.message.taker_gets = {
    currency: Currency.json_rewrite(gets.currency)
  };

  if (request.message.taker_gets.currency !== 'STR') {
    request.message.taker_gets.issuer = UInt160.json_rewrite(gets.issuer);
  }

  request.message.taker_pays = {
    currency: Currency.json_rewrite(pays.currency)
  };

  if (request.message.taker_pays.currency !== 'STR') {
    request.message.taker_pays.issuer = UInt160.json_rewrite(pays.issuer);
  }

  request.message.taker = taker ? taker : UInt160.ACCOUNT_ONE;

  request.callback(callback);

  return request;
};

/**
 * Request wallet_accounts
 *
 * @param {String} seed
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestWalletAccounts = function(seed, callback) {
  utils.assert(this.trusted); // Don't send secrets.

  var request = new Request(this, 'wallet_accounts');
  request.message.seed = seed;
  request.callback(callback);

  return request;
};

/**
 * Request sign
 *
 * @param {String} secret
 * @param {Object} tx_json
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestSign = function(secret, tx_json, callback) {
  utils.assert(this.trusted); // Don't send secrets.

  var request = new Request(this, 'sign');
  request.message.secret  = secret;
  request.message.tx_json = tx_json;
  request.callback(callback);

  return request;
};

/**
 * Request submit
 *
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestSubmit = function(callback) {
  return new Request(this, 'submit').callback(callback);
};

/**
 * Create a subscribe request with current subscriptions.
 *
 * Other classes can add their own subscriptions to this request by listening to
 * the server_subscribe event.
 *
 * This function will create and return the request, but not submit it.
 *
 * @param [Function] callback
 * @api private
 */

Remote.prototype._serverPrepareSubscribe = function(callback) {
  var self  = this;
  var feeds = [ 'ledger', 'server' ];

  if (this._transaction_subs) {
    feeds.push('transactions');
  }

  var request = this.requestSubscribe(feeds);

  function serverSubscribed(message) {
    self._stand_alone = !!message.stand_alone;
    self._testnet = !!message.testnet;

    if (message.ledger_hash && message.ledger_index) {
      self._ledger_time = message.ledger_time;
      self._ledger_hash = message.ledger_hash;
      self._ledger_current_index = message.ledger_index+1;
      self.emit('ledger_closed', message);
    }

    self.emit('subscribed');
  };

  request.once('success', serverSubscribed);

  self.emit('prepare_subscribe', request);

  request.callback(callback, 'subscribed');

  return request;
};

/**
 * For unit testing: ask the remote to accept the current ledger.
 * To be notified when the ledger is accepted, server_subscribe() then listen to 'ledger_hash' events.
 * A good way to be notified of the result of this is:
 * remote.once('ledger_closed', function(ledger_closed, ledger_index) { ... } );
 *
 * @param [Function] callback
 */

Remote.prototype.ledgerAccept =
Remote.prototype.requestLedgerAccept = function(callback) {
  if (!this._stand_alone) {
    this.emit('error', new StellarError('notStandAlone'));
    return;
  }

  var request = new Request(this, 'ledger_accept');

  this.once('ledger_closed', function(ledger) {
    request.emit('ledger_closed', ledger);
  });

  request.callback(callback, 'ledger_closed');
  request.request();

  return this;
};

/**
 * Account root request abstraction
 *
 * @api private
 */

Remote.accountRootRequest = function(type, responseFilter, account, ledger, callback) {
  if (typeof account === 'object') {
    callback = ledger;
    ledger   = account.ledger;
    account  = account.account;
  }

  var lastArg = arguments[arguments.length - 1];

  if (typeof lastArg === 'function') {
    callback = lastArg;
  }

  var request = this.requestLedgerEntry('account_root');

  request.accountRoot(account);
  request.ledgerChoose(ledger);

  request.once('success', function(message) {
    request.emit(type, responseFilter(message));
  });

  request.callback(callback, type);

  return request;
};

/**
 * Request account balance
 *
 * @param {String} account
 * @param [String|Number] ledger
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountBalance = function(account, ledger, callback) {
  function responseFilter(message) {
    return Amount.from_json(message.node.Balance);
  };

  var args = Array.prototype.concat.apply(['account_balance', responseFilter], arguments);
  var request = Remote.accountRootRequest.apply(this, args);

  return request;
};

/**
 * Request account flags
 *
 * @param {String} account
 * @param [String|Number] ledger
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestAccountFlags = function(account, ledger, callback) {
  function responseFilter(message) {
    return message.node.Flags;
  };

  var args = Array.prototype.concat.apply(['account_flags', responseFilter], arguments);
  var request = Remote.accountRootRequest.apply(this, args);

  return request;
};

/**
 * Request owner count
 *
 * @param {String} account
 * @param [String|Number] ledger
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestOwnerCount = function(account, ledger, callback) {
  function responseFilter(message) {
    return message.node.OwnerCount;
  };

  var args = Array.prototype.concat.apply(['owner_count', responseFilter], arguments);
  var request = Remote.accountRootRequest.apply(this, args);

  return request;
};

/**
 * Get an account by accountID (address)
 *
 *
 * @param {String} account
 * @return {Account}
 */

Remote.prototype.getAccount = function(accountID) {
  return this._accounts[UInt160.json_rewrite(accountID)];
};

/**
 * Add an account by accountID (address)
 *
 * @param {String} account
 * @return {Account}
 */

Remote.prototype.addAccount = function(accountID) {
  var account = new Account(this, accountID);

  if (account.isValid()) {
    this._accounts[accountID] = account;
  }

  return account;
};

/**
 * Add an account if it does not exist, return the
 * account by accountID (address)
 *
 * @param {String} account
 * @return {Account}
 */

Remote.prototype.account =
Remote.prototype.findAccount = function(accountID) {
  var account = this.getAccount(accountID);
  return account ? account : this.addAccount(accountID);
};

/**
 * Create a pathfind
 *
 * @param {Object} options
 * @return {PathFind}
 */

Remote.prototype.pathFind =
Remote.prototype.createPathFind = function(src_account, dst_account, dst_amount, src_currencies) {
  if (typeof src_account === 'object') {
    var options = src_account;
    src_currencies = options.src_currencies;
    dst_amount     = options.dst_amount;
    dst_account    = options.dst_account;
    src_account    = options.src_account;
  }

  var pathFind = new PathFind(this, src_account, dst_account, dst_amount, src_currencies);

  if (this._cur_path_find) {
    this._cur_path_find.notify_superceded();
  }

  pathFind.create();

  this._cur_path_find = pathFind;

  return pathFind;
};

Remote.prepareTrade = function(currency, issuer) {
  return currency + (currency === 'STR' ? '' : ('/' + issuer));
};

/**
 * Create an OrderBook if it does not exist, return
 * the order book
 *
 * @param {Object} options
 * @return {OrderBook}
 */

Remote.prototype.book =
Remote.prototype.createOrderBook = function(currency_gets, issuer_gets, currency_pays, issuer_pays) {
  if (typeof currency_gets === 'object') {
    var options = currency_gets;
    issuer_pays   = options.issuer_pays;
    currency_pays = options.currency_pays;
    issuer_gets   = options.issuer_gets;
    currency_gets = options.currency_gets;
  }

  var gets = Remote.prepareTrade(currency_gets, issuer_gets);
  var pays = Remote.prepareTrade(currency_pays, issuer_pays);
  var key = gets + ':' + pays;

  if (this._books.hasOwnProperty(key)) {
    return this._books[key];
  }

  var book = new OrderBook(this, currency_gets, issuer_gets, currency_pays, issuer_pays, key);

  if (book.is_valid()) {
    this._books[key] = book;
  }

  return book;
};

/**
 * Return the next account sequence
 *
 * @param {String} account
 * @param {String} sequence modifier (ADVANCE or REWIND)
 * @return {Number} sequence
 */

Remote.prototype.accountSeq =
Remote.prototype.getAccountSequence = function(account, advance) {
  var account     = UInt160.json_rewrite(account);
  var accountInfo = this.accounts[account];

  if (!accountInfo) {
    return;
  }

  var seq = accountInfo.seq;
  var change = { ADVANCE: 1, REWIND: -1 }[advance.toUpperCase()] || 0;

  accountInfo.seq += change;

  return seq;
};

/**
 * Set account sequence
 *
 * @param {String} account
 * @param {Number} sequence
 */

Remote.prototype.setAccountSeq = function(account, sequence) {
  var account = UInt160.json_rewrite(account);

  if (!this.accounts.hasOwnProperty(account)) {
    this.accounts[account] = { };
  }

  this.accounts[account].seq = sequence;
};

/**
 * Refresh an account's sequence from server
 *
 * @param {String} account
 * @param [String|Number] ledger
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.accountSeqCache = function(account, ledger, callback) {
  if (typeof account === 'object') {
    var options = account;
    callback = ledger;
    ledger   = options.ledger;
    account  = options.account;
  }

  var self = this;

  if (!this.accounts.hasOwnProperty(account)) {
    this.accounts[account] = { };
  }

  var account_info = this.accounts[account];
  var request      = account_info.caching_seq_request;

  function accountRootSuccess(message) {
    delete account_info.caching_seq_request;

    var seq = message.node.Sequence;
    account_info.seq  = seq;

    // console.log('caching: %s %d', account, seq);
    // If the caller also waits for 'success', they might run before this.
    request.emit('success_account_seq_cache', message);
  };

  function accountRootError(message) {
    // console.log('error: %s', account);
    delete account_info.caching_seq_request;

    request.emit('error_account_seq_cache', message);
  };

  if (!request) {
    // console.log('starting: %s', account);
    request = this.requestLedgerEntry('account_root');
    request.accountRoot(account);
    request.ledgerChoose(ledger);
    request.once('success', accountRootSuccess);
    request.once('error', accountRootError);

    account_info.caching_seq_request = request;
  }

  request.callback(callback, 'success_account_seq_cache', 'error_account_seq_cache');

  return request;
};

/**
 * Mark an account's root node as dirty.
 *
 * @param {String} account
 */

Remote.prototype.dirtyAccountRoot = function(account) {
  var account = UInt160.json_rewrite(account);
  delete this.ledgers.current.account_root[account];
};

/**
 * Get an account's balance
 *
 * @param {String} account
 * @param [String] issuer
 * @param [String] currency
 * @param [String|Number] ledger
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestStellarBalance = function(account, issuer, currency, ledger, callback) {
  if (typeof account === 'object') {
    var options = account;
    callback = issuer;
    ledger   = options.ledger;
    currency = options.currency;
    issuer   = options.issuer;
    account  = options.account;
  }

  var request = this.requestLedgerEntry('stellar_state'); // YYY Could be cached per ledger.

  request.stellarState(account, issuer, currency);
  request.ledgerChoose(ledger);

  function stellarState(message) {
    var node            = message.node;
    var lowLimit        = Amount.from_json(node.LowLimit);
    var highLimit       = Amount.from_json(node.HighLimit);
    // The amount the low account holds of issuer.
    var balance         = Amount.from_json(node.Balance);
    // accountHigh implies: for account: balance is negated, highLimit is the limit set by account.
    var accountHigh     = UInt160.from_json(account).equals(highLimit.issuer());

    request.emit('stellar_state', {
      account_balance     : ( accountHigh ? balance.negate() : balance.copy()).parse_issuer(account),
      peer_balance        : (!accountHigh ? balance.negate() : balance.copy()).parse_issuer(issuer),

      account_limit       : ( accountHigh ? highLimit : lowLimit).copy().parse_issuer(issuer),
      peer_limit          : (!accountHigh ? highLimit : lowLimit).copy().parse_issuer(account),

      account_quality_in  : ( accountHigh ? node.HighQualityIn : node.LowQualityIn),
      peer_quality_in     : (!accountHigh ? node.HighQualityIn : node.LowQualityIn),

      account_quality_out : ( accountHigh ? node.HighQualityOut : node.LowQualityOut),
      peer_quality_out    : (!accountHigh ? node.HighQualityOut : node.LowQualityOut),
    });
  };

  request.once('success', stellarState);
  request.callback(callback, 'stellar_state');

  return request;
};

Remote.prepareCurrencies = function(currency) {
  var newCurrency  = { };

  if (currency.hasOwnProperty('issuer')) {
    newCurrency.issuer = UInt160.json_rewrite(currency.issuer);
  }

  if (currency.hasOwnProperty('currency')) {
    newCurrency.currency = Currency.json_rewrite(currency.currency);
  }

  return newCurrency;
};

/**
 * Request static_path_find
 *
 * @param {Object} options
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestStellarPathFind = function(src_account, dst_account, dst_amount, src_currencies, callback) {
  if (typeof src_account === 'object') {
    var options = src_account;
    callback       = dst_account;
    src_currencies = options.src_currencies;
    dst_amount     = options.dst_amount;
    dst_account    = options.dst_account;
    src_account    = options.src_account;
  }

  var request = new Request(this, 'static_path_find');

  request.message.source_account      = UInt160.json_rewrite(src_account);
  request.message.destination_account = UInt160.json_rewrite(dst_account);
  request.message.destination_amount  = Amount.json_rewrite(dst_amount);

  if (src_currencies) {
    request.message.source_currencies = src_currencies.map(Remote.prepareCurrencies);
  }

  request.callback(callback);

  return request;
};

/**
 * Request find_path/create
 *
 * @param {Object} options
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestPathFindCreate = function(src_account, dst_account, dst_amount, src_currencies, callback) {
  if (typeof src_account === 'object') {
    var options = src_account;
    callback       = dst_account;
    src_currencies = options.src_currencies;
    dst_amount     = options.dst_amount;
    dst_account    = options.dst_account;
    src_account    = options.src_account;
  }

  var request = new Request(this, 'find_path');

  request.message.subcommand          = 'create';
  request.message.source_account      = UInt160.json_rewrite(src_account);
  request.message.destination_account = UInt160.json_rewrite(dst_account);
  request.message.destination_amount  = Amount.json_rewrite(dst_amount);

  if (src_currencies) {
    request.message.source_currencies = src_currencies.map(Remote.prepareCurrencies);
  }

  request.callback(callback);

  return request;
};

/**
 * Request find_path/close
 *
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestPathFindClose = function(callback) {
  var request = new Request(this, 'find_path');

  request.message.subcommand = 'close';
  request.callback(callback);

  return request;
};

/**
 * Request unl_list
 *
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestUnlList = function(callback) {
  return new Request(this, 'unl_list').callback(callback);
};

/**
 * Request unl_add
 *
 * @param {String} address
 * @param {String} comment
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestUnlAdd = function(address, comment, callback) {
  var request = new Request(this, 'unl_add');

  request.message.node = address;

  if (comment) {
    // note is not specified anywhere, should remove?
    request.message.comment = void(0);
  }

  request.callback(callback);

  return request;
};

/**
 * Request unl_delete
 *
 * @param {String} node
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestUnlDelete = function(node, callback) {
  var request = new Request(this, 'unl_delete');

  request.message.node = node;
  request.callback(callback);

  return request;
};

/**
 * Request peers
 *
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestPeers = function(callback) {
  return new Request(this, 'peers').callback(callback);
};

/**
 * Request connect
 *
 * @param {String} ip
 * @param {Number} port
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.requestConnect = function(ip, port, callback) {
  var request = new Request(this, 'connect');

  request.message.ip = ip;

  if (port) {
    request.message.port = port;
  }

  request.callback(callback);

  return request;
};

/**
 * Create a Transaction
 *
 * @param {String} source
 * @param {Object} options
 * @param [Function] callback
 * @return {Request}
 */

Remote.prototype.transaction =
Remote.prototype.createTransaction = function(source, options, callback) {
  var transaction = new Transaction(this);

  var transactionTypes = {
    payment:        'payment',
	inflation:    'inflation',
	accountdelete:'accountDelete',
    accountset:     'accountSet',
    trustset:       'trustSet',
    offercreate:    'offerCreate',
    offercancel:    'offerCancel',
    claim:          'claim',
    passwordfund:   'passwordFund',
    passwordset:    'passwordSet',
    setregularkey:  'setRegularKey',
    walletadd:      'walletAdd',
    sign:           'sign'
  };

  var transactionType;

  switch (typeof source) {
    case 'object':
      if (typeof source.type !== 'string') {
        throw new Error('Missing transaction type');
      }

      transactionType = transactionTypes[source.type.toLowerCase()];

      if (!transactionType) {
        throw new Error('Invalid transaction type: ' + transactionType);
      }

      transaction = transaction[transactionType](source);
      break;

    case 'string':
      transactionType = transactionTypes[source.toLowerCase()];

      if (!transactionType) {
        throw new Error('Invalid transaction type: ' + transactionType);
      }

      transaction = transaction[transactionType](options);
      break;
  }

  var lastArg = arguments[arguments.length - 1];

  if (typeof lastArg === 'function') {
    transaction.submit(lastArg);
  }

  return transaction;
};

/**
 * Calculate a transaction fee for a number of tx fee units.
 *
 * This takes into account the last known network and local load fees.
 *
 * @param {Number} fee units
 * @return {Amount} Final fee in XRP for specified number of fee units.
 */

Remote.prototype.feeTx = function(units) {
  var server = this._getServer();

  if (!server) {
    throw new Error('No connected servers');
  }

  return server._feeTx(units);
};

/**
 * Get the current recommended transaction fee unit.
 *
 * Multiply this value with the number of fee units in order to calculate the
 * recommended fee for the transaction you are trying to submit.
 *
 * @return {Number} Recommended amount for one fee unit as float.
 */

Remote.prototype.feeTxUnit = function() {
  var server = this._getServer();

  if (!server) {
    throw new Error('No connected servers');
  }

  return server._feeTxUnit();
};

/**
 * Get the current recommended reserve base.
 *
 * Returns the base reserve with load fees and safety margin applied.
 *
 * @param {Number} owner count
 * @return {Amount}
 */

Remote.prototype.reserve = function(owner_count) {
  var server = this._getServer();

  if (!server) {
    throw new Error('No connected servers');
  }

  return server._reserve(owner_count);
};

exports.Remote = Remote;

// vim:sw=2:sts=2:ts=8:et
"use strict";

var Halley = require('halley/backbone');
var log = require('loglevel');
var _ = require('underscore');
var Backbone = require('backbone');
var TemplateSubscription = require('./template-subscription');
var debug = require('debug-proxy')('grc:client');
var wrapExtension = require('./wrap-extension');


Halley.Promise.config({
  warnings: false,
  longStackTraces: false,
  cancellation: true
});

/* @const */
var FAYE_PREFIX = '/api';
var FAYE_PREFIX_RE = /^\/api/;
var DEFAULT_FAYE_URL = 'https://ws.gitter.im/bayeux';
var PING_RESPONSE_TIMEOUT = 30000;

var ErrorLogger = function() {};
ErrorLogger.prototype.incoming = wrapExtension(function(message, callback) {
  if(message.error) {
    debug('Bayeux error: %j', message);
  }

  callback(message);
});

var ClientAuth = function(client, options) {
  this.client = client;
  if(options.authProvider) {
    this.authProvider = options.authProvider;
  } else {
    this.authProvider = function(callback) {
      return callback({ token: options.token });
    };
  }
};

ClientAuth.prototype.outgoing = function(message, callback) {
  if(message.channel !== '/meta/handshake') return callback(message);

  var uniqueClientId = this.client.uniqueClientId;

  this.client.clientId = null;
  debug("Rehandshaking realtime connection");

  this.authProvider(function(authInfo) {
      if(!message.ext) message.ext = {};
      _.extend(message.ext, authInfo);
      message.ext.uniqueClientId = uniqueClientId;
      message.ext.realtimeLibrary = 'halley';
      callback(message);
   });
};


ClientAuth.prototype.incoming = wrapExtension(function(message, callback) {
  if(message.channel !== '/meta/handshake') return callback(message);

  if(message.successful) {
    // New clientId?
    if(this.client.clientId !== message.clientId) {
      this.client.clientId = message.clientId;
      debug("Realtime reestablished. New id is %s", this.client.clientId);
      this.client.trigger('newConnectionEstablished');
    }

    if (message.ext && message.ext.context) {
      if (message.ext.context.user) {
        this.client.user.set(message.ext.context.user);
      } else if(message.ext.context.userId) {
        this.client.user.set({ id: message.ext.context.userId });
      }
    }

    // Clear any transport problem indicators
    this.client._transportUp();
  }

  callback(message);
});

var SequenceGapDetectorExtension = function(client) {
  var self = this;
  this.client = client;
  this._seq = 0;

  client.on('newConnectionEstablished', function() {
    self._seq = 0;
  });
};

/**
 * Only perform a sequence reset at most once every 5 minutes
 */
var MIN_PERIOD_BETWEEN_RESETS = 300 * 1000;

SequenceGapDetectorExtension.prototype = {
  incoming: wrapExtension(function(message, callback) {
    var c = message.ext && message.ext.c;
    var channel = message.channel;

    if (this.lastResetTime) {
      var timeSinceLastReset = Date.now() - this.lastResetTime;
      if (timeSinceLastReset < MIN_PERIOD_BETWEEN_RESETS) {
        return callback(message);
      }
    }

    if(c && channel && channel.indexOf('/meta') !== 0) {
      if (c === 1) {
        this._seq = 1;
        this._seqStarted = true;
        return callback(message);
      }

      if (!this._seqStarted) return callback(message);

      var current = this._seq;
      this._seq = c;

      if (c !== current + 1) {
        // Stop listening to sequence messages until we get a `1` again...
        delete this._seqStarted;
        delete this._seq;
        this.lastResetTime = Date.now();

        // Reset the connection
        log.warn('rtc: Message on channel ' + channel + ' out of sequence. Expected ' + (current + 1) + ' got ' + c + '. Resetting ' + this.client.clientId);
        this.client.trigger('sequence.error');
        this.client.reset(this.client.clientId);
      }

    }
    callback(message);
  })
};

var SnapshotExtension = function(client) {
  this.client = client;
  this._listeners = {};
  this._stateProvider = {};
  this._subscribeTimers = {};
};

SnapshotExtension.prototype = {
  outgoing: function(message, callback) {
    if (message.channel !== '/meta/subscribe') return callback(message);
    var subscribeChannel = message.subscription.replace(FAYE_PREFIX_RE, '');
    this._subscribeTimers[subscribeChannel] = Date.now(); // Record start time


    function first(array, iterator) {
      if (!array || !array.length) return;
      for (var i = 0; i < array.length; i++) {
        var value = iterator(array[i], i);
        if (value !== undefined) return value;
      }
    }

    // Generic listeners register with channel `null` and receive all snapshot requests
    var genericListeners = this._listeners[null];

    /* NB: snapshot state can be 'false' so don't compare with falsy values */
    var snapshotState = first(genericListeners, function(listener) {
      if(!listener.getSnapshotStateForChannel) return;

      return listener.getSnapshotStateForChannel(subscribeChannel);
    });

    // Only try the non-generic listeners if the generic ones did not return results
    if (snapshotState === undefined) {
      var listeners = this._listeners[subscribeChannel];
      snapshotState = first(listeners, function(listener) {
        if(!listener.getSnapshotState) return;
        return listener.getSnapshotState();
      });
    }

    if (snapshotState !== undefined) {
      if (!message.ext) message.ext = {};
      message.ext.snapshot = snapshotState;
    }

    // Add generic subscribe options
    var subscribeOptions = first(genericListeners, function(listener) {
      if(!listener.getSubscribeOptions) return;

      return listener.getSubscribeOptions(subscribeChannel);
    });

    // Subscribe options must be a hash. Graft the values
    // onto the ext object
    if (subscribeOptions) {
      if (!message.ext) message.ext = {};
      _.extend(message.ext, subscribeOptions);
    }

    callback(message);
  },

  incoming: function(message, callback) {
    if (message.channel !== '/meta/subscribe' || !message.ext || !message.ext.snapshot) return callback(message);
    // Add some statistics into the mix
    var startTime = this._subscribeTimers[message.subscription];
    if (startTime) {
      delete this._subscribeTimers[message.subscription];
      var totalTime = Date.now() - startTime;

      if (totalTime > 400) {
        var lastPart = message.subscription.split(/\//).pop();
        this.client.trigger('stats', 'time', 'faye.subscribe.time.' + lastPart, totalTime);

        debug('Subscription to %s took %sms', message.subscription, totalTime);
      }
    }

    var channelListeners = this._listeners;
    var subscriptionChannel = message.subscription.replace(FAYE_PREFIX_RE, '');

    function invokeHandleSnapshot(channel) {
      var listeners = channelListeners[channel];
      var snapshot = message.ext.snapshot;

      if (!listeners) return;

      listeners.forEach(function(listener) {
        if(listener.handleSnapshot) {
          listener.handleSnapshot(snapshot, subscriptionChannel);
        }
      });
    }

    invokeHandleSnapshot(null);
    invokeHandleSnapshot(subscriptionChannel);

    callback(message);
  },

  registerSnapshotHandler: function(channel, snapshotHandler) {
    var list = this._listeners[channel];
    if (list) {
      list.push(snapshotHandler);
    } else {
      list = [snapshotHandler];
      this._listeners[channel] = list;
    }
  },

  deregisterSnapshotHandler: function(channel, snapshotHandler) {
    var list = this._listeners[channel];
    if (!list) return;

    // Remove the handler
    list = list.filter(function(handler) { return handler !== snapshotHandler; });

    if (list.length) {
      this._listeners[channel] = list;
    } else {
      delete this._listeners[channel];
    }
  }
};

function getHalleyOptions(options) {
  var halleyOptions;
  if (options.fayeOptions) {
    halleyOptions = options.fayeOptions;

    /* Backwards compatibility for Faye */
    if (halleyOptions.timeout) {
      halleyOptions.timeout = halleyOptions.timeout * 1000;
    }

    if (halleyOptions.interval) {
      halleyOptions.interval = halleyOptions.interval * 1000;
    }

    if (halleyOptions.retry) {
      halleyOptions.retry = halleyOptions.retry * 1000;
    }
  }

  if (options.halleyOptions) {
    halleyOptions = options.halleyOptions;
  }

  if (options.websocketsDisabled) {
    halleyOptions = halleyOptions || {};
    if (!halleyOptions.disabled) halleyOptions.disabled = [];

    halleyOptions.disabled.push('websocket');
  }

  return halleyOptions;
}

function RealtimeClient(options) {
  this.uniqueClientId = Math.floor(Math.random() * 100000);

  this.user = new Backbone.Model();
  var halleyOptions = getHalleyOptions(options);
  var client = new Halley.Client(options.fayeUrl || DEFAULT_FAYE_URL, halleyOptions);

  client.addExtension(new ClientAuth(this, options));
  client.addExtension(new SequenceGapDetectorExtension(this));
  client.addExtension(new ErrorLogger(this));

  this.snapshots = new SnapshotExtension(this);
  client.addExtension(this.snapshots);

  if(options.extensions) {
    options.extensions.forEach(function(extension) {
      client.addExtension(extension);
    });
  }

  // Connect early in order to obtain the userId
  client.connect();

  this.listenTo(this.user, 'change:id', function() {
    this.trigger('change:userId', this.user.id);
  });

  // Initially, the transport is down
  this._transportDown(10 /* seconds */);

  // Deprecated in favour of connection:down
  this.listenTo(client, 'transport:down', function() {
    debug('Transport down');
    this._transportDown();
  });

  // Deprecated in favour of connection:up
  this.listenTo(client, 'transport:up', function() {
    debug('Transport up');
    this._transportUp();
  });

  this.listenTo(client, 'connection:down', function() {
    this.trigger('connection:down');
  });

  this.listenTo(client, 'connection:up', function() {
    this.trigger('connection:up');
  });

  this.client = client;
}

_.extend(RealtimeClient.prototype, Backbone.Events, {

  reset: function(clientIdOnPing) {
    if(clientIdOnPing !== this.clientId) {
      debug("Ignoring reset request as clientId has changed.");
      return;
    }

    debug("Client reset requested");

    this.trigger('stats', 'event', 'faye.ping.reset');
    this.clientId = null;
    this.client.reset();
  },

  subscribe: function(channel, callback, context) {
    var fayeChannel = FAYE_PREFIX + channel;
    debug('Subscribing to %s', channel);

    return this.client.subscribe(fayeChannel, callback, context);
  },

  subscribeTemplate: function(options) {
    return new TemplateSubscription(this, options);
  },

  publish: function(channel, message) {
    return this.client.publish(FAYE_PREFIX + channel, message);
  },

  disconnect: function () {
    this.client.disconnect();
  },

  registerSnapshotHandler: function(channel, snapshotHandler) {
    return this.snapshots.registerSnapshotHandler(channel, snapshotHandler);
  },

  deregisterSnapshotHandler: function(channel, snapshotHandler) {
    return this.snapshots.deregisterSnapshotHandler(channel, snapshotHandler);
  },

  testConnection: function(reason, callback) {
    /* Wait until the connection is established before attempting the test */
    var originalClientId = this.clientId;

    if (!originalClientId || this._pingOutstanding) {
      debug('Ignoring test connection request');
      return callback && callback();
    }

    debug('Testing connection: reason=%s, clientId=%s', reason, originalClientId);

    if (reason !== 'ping') {
      this.trigger('testConnection', reason);
      debug('Testing connection due to %s', reason);
    }

    this._pingOutstanding = true;

    return this.client.publish(FAYE_PREFIX + '/v1/ping2', { reason: reason }, { deadline: PING_RESPONSE_TIMEOUT })
      .bind(this)
      .timeout(PING_RESPONSE_TIMEOUT + 1000, 'Ping timeout')
      .then(function() {
        debug('Server ping succeeded');
        return true;
      })
      .catch(function(error) {
        debug('Server ping error %j', error);
        this.reset(originalClientId);
        return false;
      })
      .finally(function() {
        this._pingOutstanding = false;
      })
      .asCallback(callback);
  },

  getClientId: function() {
    return this.clientId;
  },

  getUserId: function() {
    return this.user.id;
  },

  _transportDown: function(persistentOutageTimeout) {
    var self = this;
    var timeout = persistentOutageTimeout || 60;

    if(!this._connectionFailureTimeout) {
      this._connectionFailureTimeout = setTimeout(function() {
        if(!self._persistentOutage) {
          self._persistentOutageStartTime = Date.now();
          self._persistentOutage = true;
          debug('Persistent outage');
          self.trigger('connectionFailure');
        }
      }, timeout * 1000);
    }
  },

  _transportUp: function () {
    if(this._connectionFailureTimeout) {
      clearTimeout(this._connectionFailureTimeout);
      this._connectionFailureTimeout = null;
    }

    if(this._persistentOutage) {
      this.trigger('stats', 'event', 'faye.outage.restored');
      this.trigger('stats', 'time', 'faye.outage.restored.time', Date.now() - this._persistentOutageStartTime);
      delete this._persistentOutage;
      delete this._persistentOutageStartTime;

      debug('Persistent outage restored');
      this.trigger('connectionRestored');
    }
  }
});

module.exports = RealtimeClient;

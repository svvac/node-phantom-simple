/* global phantom, require */
/* eslint-disable strict */
/* eslint-disable no-multi-spaces */
var webpage     = require('webpage');
var webserver   = require('webserver').create();
var system      = require('system');

var pages  = {};
var page_id = 1;

var callback_stack = [];

// Define the maximum intervals (ms) while we accept not to have any contact with the master process.
// If it is reached, we consider that it has died and kill ourselves. See `masterIsAlive()`.
// We accept a different value for the initial timeout to let things settleand every actor to get up
// to speed.
var MASTER_ALIVE_TIMEOUT = 2000;
var MASTER_ALIVE_TIMEOUT_INIT = 5000;

phantom.onError = function (msg, trace) {
  var msgStack = [ 'PHANTOM ERROR: ' + msg ];

  if (trace && trace.length) {
    msgStack.push('TRACE:');
    trace.forEach(function(t) {
      msgStack.push(' -> ' + (t.file || t.sourceURL) + ': ' + t.line + (t.function ? ' (in function ' + t.function + ')' : ''));
    });
  }

  system.stderr.writeLine(msgStack.join('\n'));
  phantom.exit(1);
};

function lookup(obj, key, value) {
  // key can be either string or an array of strings
  if (!(typeof obj === 'object')) {
    return null;
  }
  if (typeof key === 'string') {
    key = key.split('.');
  }

  if (!Array.isArray(key)) {
    return null;
  }

  if (arguments.length > 2) {
    obj[key[0]] = key.length === 1 ? value : lookup(obj[key[0]] || {}, key.slice(1), value);

    return obj;
  }

  if (key.length === 1) {
    return obj[key[0]];
  }
  return lookup(obj[key[0]], key.slice(1));
}

function page_open (res, page, args) {
  page.open.apply(page, args.concat(function (success) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify({ data: success }));
    res.close();
  }));
}

function include_js (res, page, args) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.write(JSON.stringify({ data: 'success' }));

  page.includeJs.apply(page, args.concat(function () {
    try {
      res.write('');
      res.close();
    } catch (e) {
      if (!/cannot call function of deleted QObject/.test(e)) { // Ignore this error
        page.onError(e);
      }
    }
  }));
}

webserver.listen('127.0.0.1:0', function (req, res) {
  // We got a request, that means the master process is still alive
  masterIsAlive();

  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify({ data: callback_stack }));
    callback_stack = [];
    res.close();
  } else if (req.method === 'POST') {
    var request, error, output;

    try {
      request = JSON.parse(req.post);
    } catch (err) {
      error = err;
    }

    if (!error) {
      if (request.page) {
        if (request.method === 'open') { // special case this as it's the only one with a callback
          return page_open(res, pages[request.page], request.args);
        } else if (request.method === 'includeJs') {
          return include_js(res, pages[request.page], request.args);
        }
        try {
          output = pages[request.page][request.method].apply(pages[request.page], request.args);
        } catch (err) {
          error = err;
        }
      } else {
        try {
          output = global_methods[request.method].apply(global_methods, request.args);
        } catch (err) {
          error = err;
        }
      }
    }

    res.setHeader('Content-Type', 'application/json');
    if (error) {
      res.statusCode = 500;
      res.write(JSON.stringify(error));
    } else {
      res.statusCode = 200;
      res.write(JSON.stringify({ data: output }));
    }
    res.close();
  } else if (req.method === 'HEAD') {
    // We use HEAD requests as a PING mechanism to detect if the master process is gone.
    // This is a no-op, just return a 200, the only effect is that masterIsAlive() was
    // called above
    res.statusCode = 200;
    res.close();
  } else {
    throw 'Unknown request type!';
  }
});

var callbacks = [
  'onAlert', 'onCallback', 'onClosing', 'onConfirm', 'onConsoleMessage', 'onError', 'onFilePicker',
  'onInitialized', 'onLoadFinished', 'onLoadStarted', 'onNavigationRequested',
  'onPrompt', 'onResourceRequested', 'onResourceReceived', 'onResourceTimeout', 'onResourceError', 'onUrlChanged',
  // SlimerJS only
  'onAuthPrompt'
];

function setup_callbacks (id, page) {
  callbacks.forEach(function (cb) {
    page[cb] = function (parm) {
      var args = Array.prototype.slice.call(arguments);

      if ((cb === 'onResourceRequested') && (parm.url.indexOf('data:image') === 0)) {
        return;
      }

      if (cb === 'onClosing') { args = []; }
      callback_stack.push({ 'page_id': id, 'callback': cb, 'args': args });
    };
  });
  // Special case this
  page.onPageCreated = function (page) {
    var new_id = setup_page(page);
    callback_stack.push({ 'page_id': id, 'callback': 'onPageCreated', 'args': [ new_id ] });
  };
}

function setup_page (page) {
  var id    = page_id++;
  page.getProperty = function (prop) {
    return lookup(page, prop);
  };
  page.setProperty = function (prop, val) {
    lookup(page, prop, val);
    return true;
  };
  page.setFunction = function (name, fn, wrap) {
    /*eslint-disable no-eval*/
    fn = eval('(' + fn + ')');

    if (wrap === true) {
      fn = phantom.callback(fn);
    }

    lookup(page, name, fn);

    return true;
  };
  pages[id] = page;
  setup_callbacks(id, page);
  return id;
}

var global_methods = {
  setProxy: function (ip, port, proxyType, user, password) {
    return phantom.setProxy(ip, port, proxyType, user, password);
  },
  createPage: function () {
    var page  = webpage.create();
    var id = setup_page(page);
    return { page_id: id };
  },

  injectJs: function (filename) {
    return phantom.injectJs(filename);
  },

  exit: function (code) {
    masterIsAlive(-1); // Disable master alive checks
    return phantom.exit(code);
  },

  addCookie: function (cookie) {
    return phantom.addCookie(cookie);
  },

  clearCookies: function () {
    return phantom.clearCookies();
  },

  deleteCookie: function (name) {
    return phantom.deleteCookie(name);
  },

  getProperty: function (prop) {
    return lookup(phantom, prop);
  },

  setProperty: function (prop, value) {
    lookup(phantom, prop, value);
    return true;
  }
};

// If this function is called, that means the master process is gone
// and we should commit suicide
function onMasterGoneAway () {
  phantom.exit(2);
}

var _masterAliveTimeout = null;
function masterIsAlive (timeout) {
  if (_masterAliveTimeout) {
    clearTimeout(_masterAliveTimeout);
  }

  if (!timeout || timeout > 0) {
    _masterAliveTimeout = setTimeout(onMasterGoneAway, timeout || MASTER_ALIVE_TIMEOUT);
  }
}

/*eslint-disable no-console*/
console.log('Ready [' + system.pid + '] [' + webserver.port + ']');

// Wait for news from the master process
masterIsAlive(MASTER_ALIVE_TIMEOUT_INIT);

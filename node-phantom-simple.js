"use strict";

var http            = require('http');
var spawn 			= require('child_process').spawn;
var exec            = require('child_process').exec;
var util            = require('util');

var POLL_INTERVAL   = process.env.POLL_INTERVAL || 500;

var queue = function (worker) {
    var _q = [];
    var running = false;
    var q = {
        push: function (obj) {
            _q.push(obj);
            q.process();
        },
        process: function () {
            if (_q.length !== 1) {
                return;
            }
            if (running) {
                return;
            }
            running = true;
            var cb = function () {
                running = false;
                q.process();
            }
            var task = _q.shift();
            worker(task, cb);
        }
    }
    return q;
}

function callbackOrDummy (callback, poll_func) {
    if (!callback) return function () {};
    if (poll_func) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            // console.log("Polling for results before returning with: " + JSON.stringify(args));
            poll_func(function () {
                // console.log("Inside...");
                callback.apply(null, args);
            });
        }
    }
    else {
        return callback;
    }
}

function unwrapArray (arr) {
    return arr && arr.length == 1 ? arr[0] : arr
}

exports.create = function (callback, options) {
    if (options === undefined) options = {};
    if (options.phantomPath === undefined) options.phantomPath = 'phantomjs';
    if (options.parameters === undefined) options.parameters = {};

    function spawnPhantom (callback) {
        var args=[];
        for(var parm in options.parameters) {
            args.push('--' + parm + '=' + options.parameters[parm]);
        }
        args = args.concat([__dirname + '/bridge.js']);

        var phantom = spawn(options.phantomPath, args);
        phantom.once('error', function (err) {
        	callback(err);
        });
        phantom.stderr.on('data', function (data) {
            return console.warn('phantom stderr: '+data);
        });
        var exitCode = 0;
        phantom.once('exit', function (code) {
            exitCode = code;
        });

        // Wait for "Ready" line
        phantom.stdout.once('data', function (data) {
            // setup normal listener now
            phantom.stdout.on('data', function (data) {
                return console.log('phantom stdout: '+data);
            });
            if (!/Ready/.test(data)) {
                phantom.kill();
                return callback("Unexpected output from PhantomJS: " + data);
            }
            // Now need to figure out what port it's listening on - since
            // Phantom is busted and can't tell us this we need to use lsof on mac, and netstat on Linux
            // Note that if phantom could tell you the port it ends up listening
            // on we wouldn't need to do this - but instead we have to.
            var platform = require('os').platform();
            var pid = phantom.pid;
            var cmd = null;
            switch (platform) {
                case 'linux':
                            cmd = 'netstat -nlp | grep ' + pid + '/';
                            break;
                case 'darwin':
                            cmd = 'lsof -p ' + pid + ' | grep LISTEN';
                            break;
                default:
                            phantom.kill();
                            return callback("Your OS is not supported yet. Tell us how to get the listening port based on PID");
            }

            exec(cmd, function (err, stdout, stderr) {
                if (err !== null) {
                    phantom.kill();
                    return callback("Error executing command to extract port: " + err);
                }
                var match = /(?:127\.0\.0\.1|localhost):(\d+)/i.exec(stdout);
                if (!match) {
                    phantom.kill();
                    return callback("Error extracting port from: " + stdout);
                }
                var port = match[1];
                callback(null, phantom, port);
            });
        });

        setTimeout(function () {    //wait a bit to see if the spawning of phantomjs immediately fails due to bad path or similar
        	if (exitCode !== 0) {
        		return callback("Phantom immediately exited with: " + exitCode);
        	}
        },100);
    };
    
    spawnPhantom(function (err, phantom, port) {
        if (err) {
            return callback(err);
        }

        // console.log("Phantom spawned with web server on port: " + port);

        var pages = {};

        var poll_func = setup_long_poll(phantom, port, pages);

        var request_queue = queue(function (paramarr, next) {
            var params = paramarr[0];
            var callback = paramarr[1];
            var page = params[0];
            var method = params[1];
            var args = params.slice(2);
            
            var http_opts = {
                hostname: '127.0.0.1',
                port: port,
                path: '/',
                method: 'POST',
            }

            var req = http.request(http_opts, function (res) {
                res.setEncoding('utf8');
                var data = '';
                res.on('data', function (chunk) {
                    data += chunk;
                });
                res.on('end', function () {
                    if (!data) {
                        console.log("No response body for: " + method);
                    }
                    var results = JSON.parse(data);
                    // console.log("Response: ", results);
                    if (method === 'createPage') {
                        var id = results.page_id;
                        // console.log("Page created with id: " + id);
                        var methods = [
                            'addCookie', 'childFramesCount', 'childFramesName', 'clearCookies', 'close',
                            'currentFrameName', 'deleteCookie', 'evaluateJavaScript',
                            'evaluateAsync', 'getPage', 'go', 'goBack', 'goForward', 'includeJs',
                            'injectJs', 'open', 'openUrl', 'release', 'reload', 'render', 'renderBase64',
                            'sendEvent', 'setContent', 'stop', 'switchToFocusedFrame', 'switchToFrame',
                            'switchToFrame', 'switchToChildFrame', 'switchToChildFrame', 'switchToMainFrame',
                            'switchToParentFrame', 'uploadFile',
                        ];
                        pages[id] = {
                            setFn: function (name, fn, cb) {
                                request_queue.push([[id, 'setFunction', name, fn.toString()], callbackOrDummy(cb, poll_func)]);
                            },
                            get: function (name, cb) {
                                request_queue.push([[id, 'getProperty', name], callbackOrDummy(cb, poll_func)]);
                            },
                            set: function (name, val, cb) {
                                request_queue.push([[id, 'setProperty', name, val], callbackOrDummy(cb, poll_func)]);
                            },
                            evaluate: function (fn, cb) {
                                var extra_args = [];
                                if (arguments.length > 2) {
                                    extra_args = Array.prototype.slice.call(arguments, 2);
                                    // console.log("Extra args: " + extra_args);
                                }
                                request_queue.push([[id, 'evaluate', fn.toString()].concat(extra_args), callbackOrDummy(cb, poll_func)]);
                            }
                        };
                        methods.forEach(function (method) {
                            pages[id][method] = function () {
                                var all_args = Array.prototype.slice.call(arguments);
                                var callback = null;
                                if (all_args.length > 0 && typeof all_args[all_args.length - 1] === 'function') {
                                    callback = all_args.pop();
                                }
                                var req_params = [id, method];
                                request_queue.push([req_params.concat(all_args), callbackOrDummy(callback, poll_func)]);
                            }
                        });
                        
                        next();
                        return callback(null, pages[id]);
                    }
                    next();
                    callback(null, results);
                });
            });

            req.on('error', function (err) {
                console.warn("Request() error evaluating " + method + "() call: " + err);
            })

            req.setHeader('Content-Type', 'application/json');

            var json = JSON.stringify({page: page, method: method, args: args});
            req.setHeader('Content-Length', Buffer.byteLength(json));
            req.write(json);
            req.end();
        });

        var proxy = {
            process: phantom,
            createPage: function(callback) {
                request_queue.push([[0,'createPage'], callbackOrDummy(callback, poll_func)]);
            },
            injectJs: function(filename,callback){
                request_queue.push([[0,'injectJs', filename], callbackOrDummy(callback, poll_func)]);
            },
            addCookie: function(cookie, callback){
                request_queue.push([[0,'addCookie', cookie], callbackOrDummy(callback, poll_func)]);
            },                 
            exit: function(callback){
                phantom.kill('SIGTERM');
            },
            on: function () {
                phantom.on.apply(phantom, arguments);
            },
        };
        
        callback(null, proxy);


        // phantom.kill();
    });
}

function setup_long_poll (phantom, port, pages) {
    // console.log("Setting up long poll");

    var http_opts = {
        hostname: '127.0.0.1',
        port: port,
        path: '/',
        method: 'GET',
    }

    var dead = false;
    phantom.once('exit', function () { dead = true; });

    var poll_func = function (cb) {
        if (dead) return;
        // console.log("Polling...");
        var req = http.get(http_opts, function(res) {
            res.setEncoding('utf8');
            var data = '';
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                // console.log("Poll results: " + data);
                var results = JSON.parse(data);
                // if (results.length > 0) {
                //     console.log("Long poll results: ", results);
                // }
                // else {
                //     console.log("Zero callbacks");
                // }
                results.forEach(function (r) {
                    if (r.page_id) {
                        if (pages[r.page_id] && pages[r.page_id][r.callback]) {
                            pages[r.page_id][r.callback].call(pages[r.page_id], unwrapArray(r.args));
                        }
                    }
                    else {
                        var cb = callbackOrDummy(phantom[r.callback]);
                        cb.apply(phantom, r.args);
                    }
                });
                cb();
            });
        });
        req.on('error', function (err) {
            console.warn("Poll Request error: " + err);
        })
    };

    var repeater = function () {
        setTimeout(function () {
            poll_func(repeater)
        }, POLL_INTERVAL);
    }

    repeater();

    return poll_func;
}
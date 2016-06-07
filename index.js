var Express = require('express');
var Compression = require('compression');
var CookieParser = require('cookie-parser');
var BodyParser = require('body-parser');
var Path = require('path');
var Glob = require('glob');
var Handlebars = require('handlebars');
var Fs = require('fs');
var rPathSep = new RegExp(Path.sep, 'g');
var rFileExt = /\.js$/;
var clearRequireCache = function(moduleId) {
  delete require.cache[require.resolve(moduleId)];
};

/*
example opts:

{
  isProd: false,
  use: [compress()],
  render: function(template, data, callback) {},
  routes: {
    conf: './routes/routes.conf',
    routes: [],
    include: './controllers/',
    exclude: './controllers/public/** /*',
    static: {
      root: './controllers/public/'
    }
  }
}
*/

module.exports = function(o) {

  var server = Express();
  var handlers = {};
  var handlersByName = {};
  var handlersByFullName = {};
  var templatesCache = {};
  var isProd = typeof o.isProd === 'boolean' ? o.isProd : process.env.NODE_ENV === 'production';
  var isDev = !isProd;
  var api;

  var opts = {
    use: o.use,
    render: o.render,
    routes: {}
  };

  o = o || {};

  if (typeof o.routes === 'object') {
    opts.routes = {
      conf: o.routes.conf,
      routes: o.routes.routes,
      include: o.routes.include,
      exclude: o.routes.exclude,
      static: {
        root: o.routes.static && o.routes.static.root || o.routes.static
      }
    };
  }else if (Glob.hasMagic(o.routes)) {
    opts.routes = {
      include: o.routes
    };
  }

  if (typeof opts.routes.include === 'undefined') {
    opts.routes.include = Path.dirname(Path.resolve(opts.routes.conf || './routes'));
  }

  if (!opts.routes.static || !opts.routes.static.root) {
    // TODO: should we handle if opts.routes.include is a glob?
    opts.routes.static = {
      root: opts.routes.include + Path.sep + 'public' + Path.sep
    };
  }

  if (!opts.routes.exclude) {
    opts.routes.exclude = [Path.normalize(Path.relative(opts.routes.include || '.', opts.routes.static.root) + '/**'), 'node_modules/**'];
  }


  if (typeof opts.render !== 'function') {
    opts.render = function(path, data, callback) {
      path = Path.resolve(opts.routes.static.root + '/' + path);
      if (isProd && templatesCache[path]) {
        callback(null, templatesCache[path](data));
      }else {
        Fs.readFile(path, function(err, contents) {
          if (err) {
            callback(err);
          }else {
            try {
              var fn = Handlebars.compile(contents.toString());
              if (isProd) {
                templatesCache[path] = fn;
              }
              callback(null, fn(data));
            }catch(e) {
              callback(e);
            }
          }
        });
      }
    }
  }

  // TODO: add support for wiring in things like loggers, env, and config to the context that's passed to each handler
  /*
  opts.wires = {
    log: console.log.bind(log),
    env: {},
    config: {}
  }
  */

  server.disable('x-powered-by');

  server.use(Compression());
  server.use(CookieParser());
  server.use(BodyParser.urlencoded({ extended: true }));
  server.use(BodyParser.json());

  // pop out of call stack so callers have a chance to call .use() for static assets routes (e.g., CORS for fonts)
  // TODO: would be better to expose an api to start listening when ready
  process.nextTick(function() {
    server.use(Express.static(opts.routes.static.root));
  });

  
  if (Array.isArray(opts.use)) {
    opts.use.forEach(function(use) {
      server.use(use);
    });
  }

  var base = opts.routes.include;
  if (base) {
    Glob.sync('*.js', {
      cwd: base, // TODO: if we provide an api for specifying multiple routes, need to change this to the base of each route
      nodir: true,
      ignore: opts.routes.exclude,
      matchBase: true,
      realpath: true
    }).forEach(function(f) {
      var name = Path.basename(f, '.js'),
          full = Path.relative(base, f).replace(rFileExt, '').replace(rPathSep, '_'); // replacement should be a valid js identifier
      handlersByFullName[full] = handlersByName[name] = f;
      handlers[f] = {
        name: name,
        full: full
      };
    });
  }

  // TODO: need to simplify arguments list...
  function addHandler(method, path, handler, template, route) {
    server[method](path, function runHandler(req, res, next) {

      // TODO: provide way to add fields to this (and/or provide own logger, etc)
      var context = {
        logger: {
          log: console.log.bind(console, '[' + (route && route.name || path) + ']')
        },
        route: route,
        setTemplate: function(path) {
          context._template_overridepath = path;
        }
      };

      return handler.call(context, req, res, function renderResponse(data) {
        var t = context._template_overridepath || template;
        var renderFn = opts.render;

        if (req.query.dump !== 'true' && typeof t !== 'undefined' && typeof renderFn === 'function') {
          renderFn(t, data, function(err, html) {
            if (err) {
              if (isProd) {
                // TODO: send default 500
              }else if (isDev) {
                // TODO: send stacktrace as 500
              }
            }

            res.send(html);
          })
        }else {
          if (typeof data === 'object') {
            res.json(data);
          }else {
            res.send(data);
          }
        }
      });

    });
  }

  // loop over specified routes and add first
  if (opts.routes && Array.isArray(opts.routes.routes)) {
    opts.routes.routes.forEach(function(route) {
      var method = (route.method || 'all').toLowerCase();
      var path = route.path && route.path.value || route.path;
      var template = route.tags.template;
      var handlerPath = handlersByName[route.name] || handlersByFullName[route.name];
      var handler;

      // if we don't find a handler for this route, just skip... TODO: emit warning?
      if (!handlerPath) return;

      if (isProd) {
        handler = require(handlerPath) || function() {}; // TODO: should add error handling in case this blows up
      }else if (isDev) {
        handler = function() {
          clearRequireCache(handlerPath);
          return require(handlerPath).apply(this, arguments);
        };
      }

      handlers[handlerPath].isHandled = true; // mark as handled so we can iterate through remaining handlers later

      addHandler(method, path, handler, template, route);
    });
  }

  // find remaining handlers and try to add routes
  Object.keys(handlersByFullName).forEach(function(path) {
    var handlerPath = handlersByFullName[path];
    if (handlers[handlerPath] && !handlers[handlerPath].isHandled) {
      var handler = require(handlerPath);
      if (typeof handler === 'object' && typeof handler.handler === 'function') {
        var method, path;

        if (handler.path || handler['get']) {
          method = 'get';
          path = handler.path || handler['get'];
        }else if (handler.post) {
          method = 'post';
          path = handler.post;
        }else if (handler.all) {
          method = 'all';
          path = handler.all;
        }

        if (method && path) {
          handlers[handlerPath].isHandled = true;
          addHandler(method, path, handler.handler, handler.template);
        }else {
          // "unload" require so we don't interfere w/ other routes
          clearRequireCache(handlerPath);
        }

      }else {
        // "unload" require so we don't interfere w/ other routes
        clearRequireCache(handlerPath);
      }
    }
  });

  return api = {
    listen: function(port, hostname, callback) {
      if (typeof hostname === 'function') {
        callback = hostname;
        hostname = null;
      }
      server.listen(port, hostname, callback);
      return api;
    },
    // TODO: this is experimental
    getHandlers: function() {
      return handlers;
    },
    use: function() {
      return server.use.apply(server, arguments);
    }
  }

};
'use strict';

const term = require('terminal-kit').terminal;
const moment = require('moment');
const stringz = require('stringz'); // for emoji support ❤️
const request = require('request');
const stringify = require('circular-json').stringify;
var PrettyError;
var pe = {};

const gelfLevel = {
  log: 1,
  error: 3,
  warn: 4,
  info: 6,
  debug: 7,
  success: 8,
};

/*
.init({enable: ['log', 'debug', 'info', 'warn', 'error'], PrettyError: true})
*/
module.exports.init = opt => {
  (opt.enable || ['debug', 'log', 'info', 'warn', 'error']).forEach(type => {
    module.exports.makeSimpleLogger(type);
  });

  if (opt.PrettyError) {
    PrettyError = require('pretty-error');
    pe = new PrettyError();
    pe.skipNodeFiles();
    pe.skipPackage('loader.js', 'chai', 'when');
    pe.skipPath(
      'internal/main/run_main_module.js',
      'internal/modules/cjs/loader.js',
      'internal/modules/cjs/helpers.js'
    );
  }
};

// graylog init
module.exports.grayLog = opt => {
  module.exports.options.grayLog = {
    logHost: opt.logHost || null,
    host: opt.host || null,
    port: opt.port || 12201,
    path: opt.path || '/gelf',
    scope: opt.configureScope || null,
    reservedKeys: opt.reservedKeys || [],
  };

  (opt.enable || ['debug', 'log', 'warn', 'error']).forEach(type => {
    module.exports.enableGraylog(type);
  });
};

// keep the native pipe to stdout & stderr
module.exports.nativeLog = global.console.log;
module.exports.nativeError = global.console.error;

// enables or disables certain types of logging
var loggerTypes = {};
module.exports.enable = type => {
  module.exports.options.styles[type] = module.exports.options.styles[type] || [
    term,
    module.exports.nativeLog,
  ];
  loggerTypes[type] = true;
};
module.exports.disable = type => (loggerTypes[type] = false);
module.exports.isEnabled = type => loggerTypes[type];

// enables or disables certain types of logging
var loggerTypesGraylog = {};
module.exports.enableGraylog = type => {
  loggerTypesGraylog[type] = true;
};
module.exports.disableGraylog = type => (loggerTypesGraylog[type] = false);
module.exports.isEnabledGraylog = type => loggerTypesGraylog[type];

module.exports.options = {
  typePadding: '     ', // dictates the width of the type prefix
  styles: {
    // contains term styles for the various prefixes
    error: [term.error.bgRed.white, module.exports.nativeError],
    warn: [term.error.bgYellow.white, module.exports.nativeError],
    info: [term, module.exports.nativeLog],
    debug: [term.green, module.exports.nativeLog],
    success: [term.bgGreen.white, module.exports.nativeLog],
  },
  // a function that takes a date and returns a string
  // used to print the date in the prefix
  dateFormatter: date => moment(date).format('HH:mm:ss.SSS'),
  quitOnException: true,
  grayLog: {
    enabled: false,
  },
};

const getLogTypePrefix = type =>
  ` [${type}] ${module.exports.options.typePadding.substring(
    stringz.length(type) + 4
  )}`;
const getPrefix = type =>
  getLogTypePrefix(type) +
  module.exports.options.dateFormatter(new Date()) +
  ' ';
module.exports.printPrefix = (type, t = term) => {
  t(getPrefix(type));
  t.styleReset('| ');
};

function prepareLog(message) {
  let result = [];

  if (Object.prototype.toString.call(message) === '[object Error]') {
    if (pe) {
      result.push(pe.render(message));
    } else {
      result.push(
        `Error: ${message.code || ''}  ${message.message || message}`
      );

      if (message.hasOwnProperty('stack')) {
        result.push(`\nstack: ${message.stack}`);
      }

      result.push(
        `\nprocess versions: ${stringify(process.versions, null, 5)}`
      );
      result.push(
        `\nmemory usage: ${stringify(process.memoryUsage(), null, 5)}`
      );
    }
  } else if (Object.prototype.toString.call(message) === '[object Array]') {
    result.push(stringify(message, null, 5));
  } else if (Object.prototype.toString.call(message) === '[object Object]') {
    result.push(stringify(message, null, 5));
  } else {
    result.push(message);
  }

  return result; //result.length <= 1 ? result.join() :
}

function simpleLogger(logData) {
  let TYPE =
    logData.messageType == 'success'
      ? 'O'
      : logData.messageType.substr(0, 1).toUpperCase();

  //module.exports.nativeLog('DEBUG! simpleLogger()', {logData});

  let locMsg = prepareLog(logData.messages[0]);

  for (let i = 1; i < logData.messages.length; i++) {
    let message = logData.messages[i];

    if (Object.prototype.toString.call(message) === '[object Object]') {
      if (module.exports.options.grayLog.reservedKeys) {
        const keys = Object.keys(message);
        for (let k = 0; k < keys.length; k++) {
          if (
            module.exports.options.grayLog.reservedKeys.find(
              reservedKey => reservedKey == keys[k]
            )
          ) {
            delete message[keys[k]];
          }
        }
      }
    }
    if (Object.keys(message).length) {
      locMsg.push(...['\n'], ...prepareLog(message));
    }
  }

  if (loggerTypes[logData.messageType]) {
    module.exports.printPrefix(
      TYPE,
      module.exports.options.styles[logData.messageType][0]
    );
    module.exports.options.styles[logData.messageType][1].apply(this, locMsg);
  }

  sendHTTPGelf(logData);
}

module.exports.makeSimpleLogger = type => {
  module.exports.enable(type);
  global.console[type] = function() {
    simpleLogger({
      messageType: type,
      messages: arguments,
      _messagesObj_type: Object.prototype.toString.call(arguments),
    });
  };
};

module.exports.makeCustomLogger = (type, myfunction) => {
  module.exports.enable(type);
  global.console[type] = function() {
    if (loggerTypes[type]) {
      myfunction.apply(this, arguments);
    }
    if (loggerTypesGraylog[type]) {
      sendHTTPGelf(arguments);
    }
  };
};

function sendHTTPGelf(logData) {
  if (
    !module.exports.options.grayLog.host ||
    !loggerTypesGraylog[logData.messageType]
  ) {
    return;
  }

  let locMsg = {
    version: '1.1',
    host: module.exports.options.grayLog.logHost,
    level: gelfLevel[logData.messageType] || gelfLevel['info'],
    _local_timestamp: moment().toISOString(true),
    full_message: '',
  };

  if (
    Object.prototype.toString.call(logData.messages[0]) === '[object Error]'
  ) {
    if (pe) {
      pe.withoutColors();
      let peRender = pe.render(logData.messages[0]).split('\n');
      locMsg.short_message = peRender[0];
      peRender.shift();
      locMsg.full_message = peRender.join('\n');
    } else {
      locMsg.short_message = `Error: ${logData.messages[0].code || ''} ${logData
        .messages[0].message || logData.messages[0]}`;
      locMsg.full_message = '';

      if (logData.messages[0].hasOwnProperty('stack')) {
        locMsg.full_message = logData.messages[0].stack;
      }

      locMsg.full_message += `\nprocess versions: ${stringify(
        process.versions,
        null,
        5
      )}\nmemory usage: ${stringify(process.memoryUsage(), null, 5)}`;
    }
  } else {
    locMsg.short_message = prepareLog(logData.messages[0]).join();
  }

  for (let i = 1; i < logData.messages.length; i++) {
    if (
      Object.prototype.toString.call(logData.messages[i]) === '[object Object]'
    ) {
      Object.keys(logData.messages[i]).forEach(key => {
        locMsg[`_${key}`] = prepareLog(logData.messages[i][key]).join('\n');
      });
    } else {
      locMsg.full_message += `${!locMsg.full_message ? '' : '\n'}${prepareLog(
        logData.messages[i]
      ).join('\n')}`;
    }
  }

  if (module.exports.options.grayLog.scope) {
    Object.assign(locMsg, module.exports.options.grayLog.scope());
  }

  const options = {
    uri: `http://${module.exports.options.grayLog.host}:${module.exports.options.grayLog.port}${module.exports.options.grayLog.path}`,
    method: 'POST',
    timeout: 1500,
    json: true,
    body: locMsg,
  };

  //module.exports.nativeLog('>>> locMsg:', locMsg)

  request.debug = false;

  // eslint-disable-next-line no-unused-vars
  request(options, function(error, response, body) {
    if (error) {
      //return console.error(error);
      //module.exports.nativeLog('sendHTTPGelf: error: ', error);
    }
    //console.log('Upload successful!  Server responded with:', body);
    //module.exports.nativeLog('sendHTTPGelf() response: ', {
    //options,
    //statusCode: response.statusCode,
    //body,
    //});
  });
}

const exception = {
  // todo: add info about host, environment to messages
  handler(err) {
    console.error(err);
    if (module.exports.options.grayLog.quitOnException) process.exit(1);
  },
};

module.exports.handleExceptions = () => {
  process.on('unhandledRejection', exception.handler.bind(exception));
  process.on('uncaughtException', exception.handler.bind(exception));
};

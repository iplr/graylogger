'use strict';

const term = require('terminal-kit').terminal;
const moment = require('moment');
const stringz = require('stringz'); // for emoji support ❤️
const request = require('request');
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
      'internal/modules/cjs/loader.js'
    );
  }
};

// graylog init
module.exports.grayLog = opt => {
  module.exports.options.grayLog.logHost = opt.logHost || null;
  module.exports.options.grayLog.host = opt.host || null;
  module.exports.options.grayLog.port = opt.port || 12201;
  module.exports.options.grayLog.path = opt.path || '/gelf';
  module.exports.options.grayLog.configureScope = opt.configureScope || null;

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

function simpleLogger(logData) {
  let TYPE =
    logData.messageType == 'success'
      ? 'O'
      : logData.messageType.substr(0, 1).toUpperCase();

  let locMsg = [];

  if (
    Object.prototype.toString.call(logData.messages[0]) === '[object Error]' &&
    logData.messageType === 'error'
  ) {
    if (pe) {
      locMsg.push(pe.render(logData.messages[0]));
    } else {
      locMsg.push(
        `Error: ${logData.messages[0].code || ''}  ${logData.messages[0]
          .message || logData.messages[0]}`
      );

      if (logData.messages[0].hasOwnProperty('stack')) {
        locMsg.push(logData.messages[0].stack);
      }

      locMsg.push(
        `process versions: ${JSON.stringify(process.versions, null, 4)}`
      );
      locMsg.push(
        `memory usage: ${JSON.stringify(process.memoryUsage(), null, 4)}`
      );
    }
  } else if (
    Object.prototype.toString.call(logData.messages[0]) == '[object Object]'
  ) {
    locMsg.push(JSON.stringify(logData.messages[0]));
  } else {
    locMsg.push(logData.messages[0]);
  }

  for (let i = 1; i < logData.messages.length; i++) {
    locMsg.push('\n');
    if (
      Object.prototype.toString.call(logData.messages[i]) == '[object Object]'
    ) {
      locMsg.push(JSON.stringify(logData.messages[i], null, 4));
    } else {
      locMsg.push(logData.messages[i]);
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
    _local_timestamp: moment().format('DD.MM.YYYY hh:mm:ss.SSS'),
    full_message: '',
  };

  if (
    Object.prototype.toString.call(logData.messages[0]) === '[object Error]' &&
    logData.messageType === 'error'
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

      locMsg.full_message += `\nprocess versions: ${JSON.stringify(
        process.versions,
        null,
        4
      )}\nmemory usage: ${JSON.stringify(process.memoryUsage(), null, 4)}`;
    }
  } else if (
    Object.prototype.toString.call(logData.messages[0]) == '[object Object]'
  ) {
    locMsg.short_message = JSON.stringify(logData.messages[0]);
  } else {
    locMsg.short_message = logData.messages[0];
  }

  for (let i = 1; i < logData.messages.length; i++) {
    if (
      Object.prototype.toString.call(logData.messages[i]) === '[object Object]'
    ) {
      Object.keys(logData.messages[i]).forEach(key => {
        if (
          Object.prototype.toString.call(logData.messages[i][key]) ==
          '[object Object]'
        ) {
          locMsg[`_${key}`] = JSON.stringify(logData.messages[i][key], null, 4);
        } else {
          locMsg[`_${key}`] = logData.messages[i][key];
        }
      });
    } else {
      locMsg.full_message += `${!locMsg.full_message ? '' : '\n'}${
        logData.messages[i]
      }`;
    }
  }

  if (module.exports.options.grayLog.configureScope) {
    let scope = module.exports.options.grayLog.configureScope();
    Object.assign(
      locMsg,
      Object.fromEntries(
        Object.entries(scope).map(([key, value]) => [`_${key}`, value])
      )
    );
  }

  const options = {
    uri: `http://${module.exports.options.grayLog.host}:${module.exports.options.grayLog.port}${module.exports.options.grayLog.path}`,
    method: 'POST',
    timeout: 1500,
    json: true,
    body: locMsg,
  };

  request.debug = false;

  // eslint-disable-next-line no-unused-vars
  request(options, function(error, response, body) {
    if (error) {
      //return console.error('upload failed:', error);
      //module.exports.nativeLog('sendHTTPGelf: error: ', error);
    }
    //console.log('Upload successful!  Server responded with:', body);
    //module.exports.nativeLog('sendHTTPGelf() response: ', {statusCode: response.statusCode,body,});
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

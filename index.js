var term = require('terminal-kit').terminal;
var moment = require('moment');
var stringz = require('stringz'); // for emoji support ❤️
var http = require('http'); // todo: https?
var os = require('os');

var gelfLevel = new Array;
gelfLevel['LOG'] = 1;
gelfLevel['ERROR'] = 3;
gelfLevel['WARN'] = 4;
gelfLevel['INFO'] = 6;
gelfLevel['DEBUG'] = 7;
gelfLevel['SUCCESS'] = 8;

// keep the native pipe to stdout & stderr
module.exports.nativeLog = global.console.log;
module.exports.nativeError = global.console.error;

// enables or disables certain types of logging
var loggerTypes = {}
module.exports.enable = type => {
  module.exports.options.styles[type] = module.exports.options.styles[type] || [term, module.exports.nativeLog];
  loggerTypes[type] = true;
};
module.exports.disable = type => loggerTypes[type] = false;
module.exports.isEnabled = type => loggerTypes[type];

module.exports.options = {
  typePadding: '         ', // dictates the width of the type prefix
  styles: { // contains term styles for the various prefixes
    error: [term.error.bgRed.white, module.exports.nativeError],
    warn: [term.error.bgYellow.white, module.exports.nativeError],
    info: [term, module.exports.nativeLog],
    debug: [term.green, module.exports.nativeLog],
    success: [term.bgGreen.white, module.exports.nativeLog]
  },
  // a function that takes a date and returns a string
  // used to print the date in the prefix
  dateFormatter: date => moment(date).format("D/M/YY HH:mm:ss.SSS"),
  quitOnException: true,
  grayLog: {
    enabled: false
  }
}

var getLogTypePrefix = type => ` [${type}] ${module.exports.options.typePadding.substring(stringz.length(type) + 4)}`;
var getPrefix = type => getLogTypePrefix(type) + module.exports.options.dateFormatter(new Date()) + " ";
module.exports.printPrefix = (type, t = term) => {
  t(getPrefix(type));
  t.styleReset("| ")
};

function simpleLogger(logData) {
//  module.exports.nativeLog('simpleLogger: '+JSON.stringify(logData));

  //  module.exports.nativeLog('simpleLogger: msg typeof:'+Object.prototype.toString.call(logData.messages[0]));

  var TYPE = logData.messageType == "success" ? "OK" : logData.messageType.toUpperCase();
  if (loggerTypes[logData.messageType]) {
    module.exports.printPrefix(TYPE, module.exports.options.styles[logData.messageType][0]);
    module.exports.options.styles[logData.messageType][1].apply(this, getMessage(logData.messages));
    // todo: do I need to use callback here?
    sendHTTPGelf(logData);
  }
}

module.exports.makeSimpleLogger = type => {
  module.exports.enable(type);
  global.console[type] = function() {
    simpleLogger({
      'messageType': type,
      'messages': arguments,
      '_messagesObj_type': Object.prototype.toString.call(arguments)
    });
  }
}

module.exports.makeCustomLogger = (type, myfunction) => {
  module.exports.enable(type);
  global.console[type] = function() {
    if (loggerTypes[type]) {
      myfunction.apply(this, arguments);
      sendHTTPGelf(arguments);
    }
  };
}

module.exports.makeSimpleLogger("debug");
module.exports.makeSimpleLogger("info");
global.console.log = global.console.info;
module.exports.makeSimpleLogger("warn");
module.exports.makeSimpleLogger("success");
module.exports.makeSimpleLogger("error");

/*
todo: disabled to improve

module.exports.makeCustomLogger("error", function() {
  var isTrace = typeof arguments[0] == "string" && arguments[0].substring(0, 5) == "Trace";
  var type = isTrace ? "TRACE" : "ERROR";
  module.exports.printPrefix(type, module.exports.options.styles.error[0]);
  if (isTrace) {
    arguments[0] = arguments[0].substring(7);
  }
  module.exports.options.styles.error[1].apply(this, arguments);
})
*/

module.exports.grayLog = (opt) => {
  // todo: add to source default os.hostname?
  module.exports.options.grayLog.logHost = opt.hasOwnProperty('logHost') ? opt.logHost : '';
  module.exports.options.grayLog.host = opt.hasOwnProperty('host') ? opt.host : '';
  module.exports.options.grayLog.port = opt.hasOwnProperty('port') ? opt.port : 12201;
  module.exports.options.grayLog.path = opt.hasOwnProperty('path') ? opt.path : '/gelf';

  // todo: check connections to graylog and callback w/ status

  module.exports.options.grayLog.enabled = true;
}


function getMessage(messages) {
  if (Object.prototype.toString.call(messages[0]) == '[object Object]') {
    if (messages[0].hasOwnProperty('short_message')) {
      messages[0] = messages[0].short_message;
    } else {
      messages[0] = JSON.stringify(messages[0], null, 4);
    }
  }
  return messages;
}


function sendHTTPGelf(logData, callback) {
  if (!module.exports.options.grayLog.enabled) {
    //    callback(throw new Error('GrayLog disabled'));
    return;
  }

  // use try, чтобы исключить зацикливание ошибок, логирование которых появится при выполнении
  // todo: надо брать дополнительные поля из logData, которые начинаются с "_" и включать в gelf
  // todo: queue if undelivered message
  // todo: add local time zone
  // todo: use callback?''

  //  module.exports.nativeLog('sendHTTPGelf:'+JSON.stringify(logData));

  var locMsg = {};

  // module.exports.nativeLog('typeof: '+Object.prototype.toString.call(logData.messages[0]));

  if (Object.prototype.toString.call(logData.messages[0]) == '[object Error]') {
    locMsg = {
      short_message: 'Error: ' + (logData.messages[0].code || '') + (logData.messages[0].message || logData.messages[0]),
      '_error': 1,
      full_message: ''
    }
    if (logData.messages[0].hasOwnProperty('stack')) {
      locMsg.full_message = logData.messages[0].stack;
      locMsg['_error'] = 2;
    }

    locMsg.full_message = locMsg.full_message + '\nprocess versions: ' + JSON.stringify(process.versions, null, 4) + '\nmemory usage:' + JSON.stringify(process.memoryUsage(), null, 4);
  } else if (Object.prototype.toString.call(logData.messages[0]) == '[object Object]')
    if (logData.messages[0].hasOwnProperty('short_message')) locMsg = logData.messages[0]
    else locMsg = JSON.stringify(logData.messages[0], null, 4);
  else
    locMsg = {
      short_message: logData.messages[0]
    }

  locMsg.version = '1.1';
  locMsg.host = module.exports.options.grayLog.logHost;
  locMsg.level = gelfLevel[logData.messageType.toUpperCase()] || gelfLevel['INFO'];
  locMsg['_local_timestamp'] = moment().toISOString();

  if (logData.messages.length > 1) locMsg.full_message = JSON.stringify(Array.prototype.slice.call(logData.messages, 1), null, 4);

  //  module.exports.nativeLog('sendHTTPGelf:'+JSON.stringify(locMsg));

  var options = {
    hostname: module.exports.options.grayLog.host,
    port: module.exports.options.grayLog.port,
    path: module.exports.options.grayLog.path,
    method: 'POST',
    rejectUnauthorized: false,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(JSON.stringify(locMsg))
    },
    timeout: 1500
  };

  var req = http.request(options, (res) => {
    // todo: some debug?
  });

  req.on('error', (e) => {
    if ((e.code != 'ETIMEDOUT') && (locMsg.short_message != 'Error: ' + (e.code || '') + (e.message || e))) console.warn(e);
  });

  req.write(JSON.stringify(locMsg));
  req.end();
}

var exception = {
  // todo: add info about host, environment to messages
  handler(err) {
    console.error(err);
    if (module.exports.options.grayLog.quitOnException) process.exit()
  }
}

module.exports.handleExceptions = () => {
  process.on('unhandledRejection', exception.handler.bind(exception));
  process.on("uncaughtException", exception.handler.bind(exception));
  // todo: is it need handle? process.on(SIGUSR1)
}


// todo: add git support like this https://github.com/observing/exception
// todo:

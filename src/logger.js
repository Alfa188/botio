const path = require('path');
const winston = require('winston');

const logDir = path.join(__dirname, '..', 'logs');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      )
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'bot.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'errors.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 3
    })
  ]
});

module.exports = logger;

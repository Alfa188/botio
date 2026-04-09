const winston = require('winston');
const path = require('path');

const transports = [new winston.transports.Console()];

// Only write to file outside Docker (avoids conflicts when scaling)
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.File({
    filename: path.join(__dirname, '..', 'bot.log'),
    maxsize: 5 * 1024 * 1024,
    maxFiles: 3,
  }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports,
});

module.exports = logger;


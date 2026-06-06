import { logger, LogLevel, nameToLogLevel } from './common/logger/index.js';
import type { KeeperConfig } from './config.js';

/** Initialize the @tlsn/common singleton logger from the keeper config. */
export function initLogger(cfg: KeeperConfig): void {
  const level = nameToLogLevel(cfg.logLevel) ?? LogLevel.INFO;
  logger.init(level);
}

export { logger };

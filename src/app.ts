import "dotenv/config";
import { loadConfig, type LoadedConfig } from "./config/load.ts";
import { openDb, type Db } from "./db/index.ts";
import { registerConfigVersion } from "./db/repo.ts";
import { initLogger, type Logger } from "./util/logger.ts";

export interface AppContext {
  lc: LoadedConfig;
  db: Db;
  log: Logger;
  configVersion: string;
}

export interface Endpoints {
  httpUrl: string;
  wsUrl: string;
}

/** Read RPC endpoints from the env vars named in the config (never from the config itself). */
export function endpoints(lc: LoadedConfig): Endpoints {
  const httpUrl = process.env[lc.config.rpc.http_url_env];
  const wsUrl = process.env[lc.config.rpc.ws_url_env];
  if (!httpUrl) throw new Error(`Missing env var ${lc.config.rpc.http_url_env} (see .env.example)`);
  if (!wsUrl) throw new Error(`Missing env var ${lc.config.rpc.ws_url_env} (see .env.example)`);
  return { httpUrl, wsUrl };
}

export function createApp(configPath?: string, opts: { stdoutLogs?: boolean } = {}): AppContext {
  const lc = loadConfig(configPath);
  const c = lc.config.app;
  const log = initLogger({
    level: c.log_level,
    logDir: c.log_dir,
    frequency: c.log_rotate.frequency,
    size: c.log_rotate.size,
    keepFiles: c.log_rotate.keep_files,
    stdout: opts.stdoutLogs ?? false,
  });
  const db = openDb(c.db_path);
  const configVersion = registerConfigVersion(db, lc);
  return { lc, db, log, configVersion };
}

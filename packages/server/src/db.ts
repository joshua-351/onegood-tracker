import Database from "better-sqlite3";
import path from "path";
import { serverRootLogger } from "./logger";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "..", "data", "tracker.db");

let db: Database.Database | null = null;

export function initDatabase(): Database.Database {
  if (db !== null) {
    return db;
  }

  const dbDir = path.dirname(DB_PATH);
  const fs = require("fs");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // 创建追踪池表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracking_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_id TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      shop_domain TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'exception')),
      exception_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked_at DATETIME,
      delivered_at DATETIME,
      UNIQUE(carrier_id, tracking_number)
    )
  `);

  // 创建追踪历史表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracking_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id INTEGER NOT NULL,
      status TEXT,
      description TEXT,
      location TEXT,
      event_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pool_id) REFERENCES tracking_pool(id) ON DELETE CASCADE
    )
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracking_pool_status ON tracking_pool(status);
    CREATE INDEX IF NOT EXISTS idx_tracking_pool_order_id ON tracking_pool(order_id);
    CREATE INDEX IF NOT EXISTS idx_tracking_history_pool_id ON tracking_history(pool_id);
  `);

  serverRootLogger.info(`Database initialized at ${DB_PATH}`);
  return db;
}

export function getDatabase(): Database.Database {
  if (db === null) {
    return initDatabase();
  }
  return db;
}

export function closeDatabase(): void {
  if (db !== null) {
    db.close();
    db = null;
    serverRootLogger.info("Database closed");
  }
}

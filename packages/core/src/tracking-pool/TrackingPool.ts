import { DateTime } from "luxon";

export enum TrackingPoolStatus {
  Active = "active",
  Completed = "completed",
  Exception = "exception",
}

export interface TrackingPoolEntry {
  id: number;
  carrierId: string;
  trackingNumber: string;
  orderId: number;
  shopDomain: string;
  status: TrackingPoolStatus;
  exceptionReason: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
  lastCheckedAt: DateTime | null;
  deliveredAt: DateTime | null;
}

export interface TrackingHistoryEntry {
  id: number;
  poolId: number;
  status: string | null;
  description: string | null;
  location: string | null;
  eventTime: DateTime | null;
  createdAt: DateTime;
}

export interface AddToTrackingPoolInput {
  carrierId: string;
  trackingNumber: string;
  orderId: number;
  shopDomain: string;
}

export interface TrackingPoolFilter {
  status?: TrackingPoolStatus;
  orderId?: number;
  shopDomain?: string;
}

export interface Statement {
  run(...params: any): { lastInsertRowid: number; changes: number };
  get<T>(...params: any): T | undefined;
  all<T>(...params: any): T[];
}

export interface IDatabase {
  prepare(sql: string): Statement;
  exec(sql: string): void;
}

export interface ITrackingPool {
  add(input: AddToTrackingPoolInput): TrackingPoolEntry;
  remove(carrierId: string, trackingNumber: string): boolean;
  getById(id: number): TrackingPoolEntry | null;
  getActive(): TrackingPoolEntry[];
  getAll(filter?: TrackingPoolFilter): TrackingPoolEntry[];
  markCompleted(id: number, deliveredAt?: DateTime): boolean;
  markException(id: number, reason: string): boolean;
  updateLastChecked(id: number): boolean;
  addHistory(poolId: number, status: string | null, description: string | null, location: string | null, eventTime: DateTime | null): TrackingHistoryEntry;
  getHistory(poolId: number): TrackingHistoryEntry[];
}

export class TrackingPool implements ITrackingPool {
  constructor(private db: IDatabase) {}

  add(input: AddToTrackingPoolInput): TrackingPoolEntry {
    const now = DateTime.now().toISO();
    const stmt = this.db.prepare(`
      INSERT INTO tracking_pool (carrier_id, tracking_number, order_id, shop_domain, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);
    const result = stmt.run(
      input.carrierId,
      input.trackingNumber,
      input.orderId,
      input.shopDomain,
      now,
      now
    );

    return this.getById(result.lastInsertRowid as number)!;
  }

  remove(carrierId: string, trackingNumber: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM tracking_pool WHERE carrier_id = ? AND tracking_number = ?
    `);
    const result = stmt.run(carrierId, trackingNumber);
    return result.changes > 0;
  }

  getById(id: number): TrackingPoolEntry | null {
    const stmt = this.db.prepare(`SELECT * FROM tracking_pool WHERE id = ?`);
    const row = stmt.get<any>(id);
    return row ? this.mapRowToEntry(row) : null;
  }

  getActive(): TrackingPoolEntry[] {
    return this.getAll({ status: TrackingPoolStatus.Active });
  }

  getAll(filter?: TrackingPoolFilter): TrackingPoolEntry[] {
    let sql = `SELECT * FROM tracking_pool WHERE 1=1`;
    const params: any[] = [];

    if (filter?.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter?.orderId) {
      sql += ` AND order_id = ?`;
      params.push(filter.orderId);
    }
    if (filter?.shopDomain) {
      sql += ` AND shop_domain = ?`;
      params.push(filter.shopDomain);
    }

    sql += ` ORDER BY created_at DESC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all<any>(params);
    return rows.map((row) => this.mapRowToEntry(row));
  }

  markCompleted(id: number, deliveredAt?: DateTime): boolean {
    const now = DateTime.now().toISO();
    const delivered = deliveredAt?.toISO() || now;
    const stmt = this.db.prepare(`
      UPDATE tracking_pool
      SET status = 'completed', updated_at = ?, delivered_at = ?
      WHERE id = ? AND status = 'active'
    `);
    const result = stmt.run(now, delivered, id);
    return result.changes > 0;
  }

  markException(id: number, reason: string): boolean {
    const now = DateTime.now().toISO();
    const stmt = this.db.prepare(`
      UPDATE tracking_pool
      SET status = 'exception', exception_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `);
    const result = stmt.run(reason, now, id);
    return result.changes > 0;
  }

  updateLastChecked(id: number): boolean {
    const now = DateTime.now().toISO();
    const stmt = this.db.prepare(`
      UPDATE tracking_pool SET last_checked_at = ? WHERE id = ?
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  addHistory(poolId: number, status: string | null, description: string | null, location: string | null, eventTime: DateTime | null): TrackingHistoryEntry {
    const now = DateTime.now().toISO();
    const stmt = this.db.prepare(`
      INSERT INTO tracking_history (pool_id, status, description, location, event_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      poolId,
      status,
      description,
      location,
      eventTime?.toISO() || null,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      poolId,
      status,
      description,
      location,
      eventTime,
      createdAt: DateTime.fromISO(now!),
    };
  }

  getHistory(poolId: number): TrackingHistoryEntry[] {
    const stmt = this.db.prepare(`SELECT * FROM tracking_history WHERE pool_id = ? ORDER BY created_at DESC`);
    const rows = stmt.all<any>(poolId);
    return rows.map((row) => ({
      id: row.id,
      poolId: row.pool_id,
      status: row.status,
      description: row.description,
      location: row.location,
      eventTime: row.event_time ? DateTime.fromISO(row.event_time) : null,
      createdAt: DateTime.fromISO(row.created_at),
    }));
  }

  private mapRowToEntry(row: any): TrackingPoolEntry {
    return {
      id: row.id,
      carrierId: row.carrier_id,
      trackingNumber: row.tracking_number,
      orderId: row.order_id,
      shopDomain: row.shop_domain,
      status: row.status as TrackingPoolStatus,
      exceptionReason: row.exception_reason,
      createdAt: DateTime.fromISO(row.created_at),
      updatedAt: DateTime.fromISO(row.updated_at),
      lastCheckedAt: row.last_checked_at ? DateTime.fromISO(row.last_checked_at) : null,
      deliveredAt: row.delivered_at ? DateTime.fromISO(row.delivered_at) : null,
    };
  }
}

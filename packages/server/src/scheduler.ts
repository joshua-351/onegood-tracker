import cron from "node-cron";
import { DateTime } from "luxon";
import { TrackingPool, TrackingPoolStatus, type IDatabase, type ITrackingPool, type CarrierRegistry, type WooCommerceSync } from "@delivery-tracker/core";
import { serverRootLogger } from "./logger";
import { TrackEventStatusCode } from "@delivery-tracker/core";

// 配置参数 (可从环境变量覆盖)
const SCAN_INTERVAL_MINUTES = parseInt(process.env.SCHEDULER_INTERVAL_MINUTES || "30", 10);
const EXCEPTION_THRESHOLD_DAYS = parseInt(process.env.EXCEPTION_THRESHOLD_DAYS || "15", 10);
const MAX_CONCURRENCY = parseInt(process.env.SCHEDULER_MAX_CONCURRENCY || "10", 10);
const BATCH_DELAY_MS = parseInt(process.env.SCHEDULER_BATCH_DELAY_MS || "200", 10);
const BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE || "50", 10);

export interface SchedulerDeps {
  db: IDatabase;
  carrierRegistry: CarrierRegistry;
  wooCommerceSync: WooCommerceSync;
}

export class Scheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private trackingPool: ITrackingPool;
  private carrierRegistry: CarrierRegistry;
  private wooCommerceSync: WooCommerceSync;
  private isRunning = false;

  constructor(deps: SchedulerDeps) {
    this.trackingPool = new TrackingPool(deps.db);
    this.carrierRegistry = deps.carrierRegistry;
    this.wooCommerceSync = deps.wooCommerceSync;
  }

  start(): void {
    if (this.cronJob) {
      serverRootLogger.warn("Scheduler already started");
      return;
    }

    serverRootLogger.info(`Scheduler configured: interval=${SCAN_INTERVAL_MINUTES}min, concurrency=${MAX_CONCURRENCY}, batchSize=${BATCH_SIZE}, delay=${BATCH_DELAY_MS}ms`);

    // Schedule to run every 30 minutes
    this.cronJob = cron.schedule(`*/${SCAN_INTERVAL_MINUTES} * * * *`, async () => {
      await this.scanTrackingPool();
    });

    serverRootLogger.info(`Scheduler started, running every ${SCAN_INTERVAL_MINUTES} minutes`);
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      serverRootLogger.info("Scheduler stopped");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async processWithConcurrency<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    concurrency: number
  ): Promise<void> {
    const queue = [...items];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      // 填充到并发上限
      while (queue.length > 0 && running.length < concurrency) {
        const item = queue.shift()!;
        const promise = processor(item).finally(() => {
          const idx = running.indexOf(promise);
          if (idx >= 0) running.splice(idx, 1);
        });
        running.push(promise);
      }

      // 等待任意一个完成
      if (running.length > 0) {
        await Promise.race(running);
      }
    }
  }

  async scanTrackingPool(): Promise<void> {
    // 防止重复运行
    if (this.isRunning) {
      serverRootLogger.warn("Previous scan still running, skipping this run");
      return;
    }

    this.isRunning = true;
    serverRootLogger.info("Starting tracking pool scan");

    try {
      const activeTrackings = this.trackingPool.getActive();
      serverRootLogger.info(`Found ${activeTrackings.length} active trackings`);

      if (activeTrackings.length === 0) {
        return;
      }

      // 分批处理
      for (let i = 0; i < activeTrackings.length; i += BATCH_SIZE) {
        const batch = activeTrackings.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(activeTrackings.length / BATCH_SIZE);

        serverRootLogger.info(`Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);

        await this.processWithConcurrency(batch, async (tracking) => {
          try {
            await this.checkTracking(tracking.id);
          } catch (error) {
            serverRootLogger.error("Error checking tracking", {
              id: tracking.id,
              carrierId: tracking.carrierId,
              trackingNumber: tracking.trackingNumber,
              error,
            });
          }
        }, MAX_CONCURRENCY);

        // 批次间延迟
        if (i + BATCH_SIZE < activeTrackings.length) {
          await this.sleep(BATCH_DELAY_MS);
        }
      }

      // Check for exceptions (trackings older than threshold)
      await this.checkExceptions();

      serverRootLogger.info("Tracking pool scan completed");
    } finally {
      this.isRunning = false;
    }
  }

  private async checkTracking(poolId: number): Promise<void> {
    const tracking = this.trackingPool.getById(poolId);
    if (!tracking || tracking.status !== TrackingPoolStatus.Active) {
      return;
    }

    const carrier = this.carrierRegistry.get(tracking.carrierId);
    if (!carrier) {
      serverRootLogger.warn("Carrier not found", { carrierId: tracking.carrierId });
      return;
    }

    try {
      const trackInfo = await carrier.track({ trackingNumber: tracking.trackingNumber });
      this.trackingPool.updateLastChecked(poolId);

      // Check for delivered status
      const deliveredEvent = trackInfo.events.find(
        (e) => e.status.code === TrackEventStatusCode.Delivered
      );

      if (deliveredEvent) {
        // Mark as completed and update WooCommerce
        this.trackingPool.markCompleted(poolId, deliveredEvent.time || undefined);

        // Add history
        this.trackingPool.addHistory(
          poolId,
          "DELIVERED",
          deliveredEvent.description,
          deliveredEvent.location?.name || null,
          deliveredEvent.time || null
        );

        // Update WooCommerce order status to completed
        await this.wooCommerceSync.updateOrderStatus(
          tracking.orderId,
          "completed",
          tracking.shopDomain
        );

        serverRootLogger.info("Tracking delivered", {
          poolId,
          orderId: tracking.orderId,
          trackingNumber: tracking.trackingNumber,
        });
        return;
      }

      // Add last event to history
      if (trackInfo.events.length > 0) {
        const lastEvent = trackInfo.events[trackInfo.events.length - 1];
        this.trackingPool.addHistory(
          poolId,
          lastEvent.status.code,
          lastEvent.description,
          lastEvent.location?.name || null,
          lastEvent.time || null
        );
      }

      serverRootLogger.info("Tracking checked", {
        poolId,
        trackingNumber: tracking.trackingNumber,
        lastEvent: trackInfo.events.length > 0
          ? trackInfo.events[trackInfo.events.length - 1].status.code
          : "NONE",
      });
    } catch (error) {
      serverRootLogger.error("Error fetching tracking info", {
        poolId,
        trackingNumber: tracking.trackingNumber,
        error,
      });
    }
  }

  private async checkExceptions(): Promise<void> {
    const now = DateTime.now();
    const activeTrackings = this.trackingPool.getActive();

    for (const tracking of activeTrackings) {
      const daysSinceCreation = now.diff(tracking.createdAt, "days").days;

      if (daysSinceCreation > EXCEPTION_THRESHOLD_DAYS) {
        const reason = `Tracking exceeded ${EXCEPTION_THRESHOLD_DAYS} days without delivery`;
        this.trackingPool.markException(tracking.id, reason);

        serverRootLogger.warn("Tracking marked as exception", {
          poolId: tracking.id,
          trackingNumber: tracking.trackingNumber,
          daysSinceCreation,
        });
      }
    }
  }

  // Run scan immediately (for testing)
  async runNow(): Promise<void> {
    await this.scanTrackingPool();
  }
}

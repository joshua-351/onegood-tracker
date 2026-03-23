import { Router, Request, Response } from "express";
import { TrackingPool, TrackingPoolStatus, type AddToTrackingPoolInput, type IDatabase } from "@delivery-tracker/core";
import { serverRootLogger } from "../logger";

export interface TrackingPoolRouteDeps {
  db: IDatabase;
  authSecret?: string;
}

export function createTrackingPoolRouter(deps: TrackingPoolRouteDeps): Router {
  const router = Router();
  const trackingPool = new TrackingPool(deps.db);

  // Auth middleware
  const authMiddleware = (req: Request, res: Response, next: Function) => {
    if (deps.authSecret) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${deps.authSecret}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    next();
  };

  // Add tracking to pool
  router.post("/", authMiddleware, (req: Request, res: Response) => {
    try {
      const { carrierId, trackingNumber, orderId, shopDomain } = req.body;

      if (!carrierId || !trackingNumber || !orderId || !shopDomain) {
        res.status(400).json({ error: "Missing required fields: carrierId, trackingNumber, orderId, shopDomain" });
        return;
      }

      const input: AddToTrackingPoolInput = {
        carrierId,
        trackingNumber,
        orderId: parseInt(orderId, 10),
        shopDomain,
      };

      const entry = trackingPool.add(input);
      serverRootLogger.info("Added to tracking pool", { carrierId, trackingNumber, orderId });

      res.status(201).json({
        success: true,
        data: {
          id: entry.id,
          carrierId: entry.carrierId,
          trackingNumber: entry.trackingNumber,
          orderId: entry.orderId,
          shopDomain: entry.shopDomain,
          status: entry.status,
          createdAt: entry.createdAt.toISO(),
        },
      });
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        // Already exists, return the existing entry
        const existing = trackingPool.getAll().find(
          (e) => e.carrierId === req.body.carrierId && e.trackingNumber === req.body.trackingNumber
        );
        if (existing) {
          res.status(200).json({
            success: true,
            data: {
              id: existing.id,
              carrierId: existing.carrierId,
              trackingNumber: existing.trackingNumber,
              orderId: existing.orderId,
              shopDomain: existing.shopDomain,
              status: existing.status,
              createdAt: existing.createdAt.toISO(),
            },
            message: "Already exists",
          });
          return;
        }
      }
      serverRootLogger.error("Error adding to tracking pool", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete tracking from pool
  router.delete("/:carrierId/:trackingNumber", authMiddleware, (req: Request, res: Response) => {
    try {
      const { carrierId, trackingNumber } = req.params;
      const removed = trackingPool.remove(carrierId, trackingNumber);

      if (removed) {
        serverRootLogger.info("Removed from tracking pool", { carrierId, trackingNumber });
        res.status(200).json({ success: true });
      } else {
        res.status(404).json({ error: "Tracking not found" });
      }
    } catch (error) {
      serverRootLogger.error("Error removing from tracking pool", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all tracking pool entries
  router.get("/", authMiddleware, (req: Request, res: Response) => {
    try {
      const { status, orderId, shopDomain } = req.query;

      const filter: any = {};
      if (status) {
        filter.status = status as TrackingPoolStatus;
      }
      if (orderId) {
        filter.orderId = parseInt(orderId as string, 10);
      }
      if (shopDomain) {
        filter.shopDomain = shopDomain as string;
      }

      const entries = trackingPool.getAll(filter);
      res.status(200).json({
        success: true,
        data: entries.map((e) => ({
          id: e.id,
          carrierId: e.carrierId,
          trackingNumber: e.trackingNumber,
          orderId: e.orderId,
          shopDomain: e.shopDomain,
          status: e.status,
          exceptionReason: e.exceptionReason,
          createdAt: e.createdAt.toISO(),
          updatedAt: e.updatedAt.toISO(),
          lastCheckedAt: e.lastCheckedAt?.toISO() || null,
          deliveredAt: e.deliveredAt?.toISO() || null,
        })),
      });
    } catch (error) {
      serverRootLogger.error("Error getting tracking pool", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get single tracking pool entry
  router.get("/:id", authMiddleware, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const entry = trackingPool.getById(id);

      if (!entry) {
        res.status(404).json({ error: "Tracking not found" });
        return;
      }

      const history = trackingPool.getHistory(id);

      res.status(200).json({
        success: true,
        data: {
          id: entry.id,
          carrierId: entry.carrierId,
          trackingNumber: entry.trackingNumber,
          orderId: entry.orderId,
          shopDomain: entry.shopDomain,
          status: entry.status,
          exceptionReason: entry.exceptionReason,
          createdAt: entry.createdAt.toISO(),
          updatedAt: entry.updatedAt.toISO(),
          lastCheckedAt: entry.lastCheckedAt?.toISO() || null,
          deliveredAt: entry.deliveredAt?.toISO() || null,
          history: history.map((h) => ({
            id: h.id,
            status: h.status,
            description: h.description,
            location: h.location,
            eventTime: h.eventTime?.toISO() || null,
            createdAt: h.createdAt.toISO(),
          })),
        },
      });
    } catch (error) {
      serverRootLogger.error("Error getting tracking pool entry", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

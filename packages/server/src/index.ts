import type * as winston from "winston";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerErrorCode, unwrapResolverError } from "@apollo/server/errors";
import { typeDefs, resolvers, type AppContext } from "@delivery-tracker/api";
import {
  DefaultCarrierRegistry,
  WooCommerceSync,
  logger as coreLogger,
} from "@delivery-tracker/core";
import { initLogger, serverRootLogger } from "./logger";
import { initDatabase, getDatabase, closeDatabase } from "./db";
import { createTrackingPoolRouter } from "./routes";
import { Scheduler } from "./scheduler";

// Auth secret for tracking pool API
const AUTH_SECRET = process.env.TRACKING_POOL_AUTH_SECRET;
const PORT = parseInt(process.env.PORT || "4000", 10);
const GRAPHQL_PATH = process.env.GRAPHQL_PATH || "/graphql";

function createAppContext(carrierRegistry: DefaultCarrierRegistry): AppContext {
  return {
    carrierRegistry,
  };
}

async function main(): Promise<void> {
  // Initialize database
  const db = initDatabase();

  // Initialize carrier registry
  const carrierRegistry = new DefaultCarrierRegistry();
  await carrierRegistry.init();

  // Initialize WooCommerce sync
  const wooCommerceSync = new WooCommerceSync();
  // Configure shops from environment variables
  // Format: WOOCOMMERCE_SHOP_{domain}="consumer_key:consumer_secret"
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WOOCOMMERCE_SHOP_")) {
      const shopDomain = key.replace("WOOCOMMERCE_SHOP_", "").toLowerCase();
      const [consumerKey, consumerSecret] = (value as string).split(":");
      if (consumerKey && consumerSecret) {
        wooCommerceSync.addShop({
          shopDomain,
          consumerKey,
          consumerSecret,
        });
        serverRootLogger.info(`Configured WooCommerce shop: ${shopDomain}`);
      }
    }
  }

  // Create Express app
  const app: Express = express();
  app.use(express.json());

  // Create Apollo Server
  const apolloServer = new ApolloServer({
    typeDefs,
    resolvers: resolvers.resolvers,
    formatError: (formattedError, error) => {
      const extensions = formattedError.extensions ?? {};
      switch (extensions.code) {
        case "INTERNAL":
        case "BAD_REQUEST":
        case "NOT_FOUND":
        case ApolloServerErrorCode.INTERNAL_SERVER_ERROR:
          extensions.code = "INTERNAL";
          break;
        case ApolloServerErrorCode.GRAPHQL_PARSE_FAILED:
          extensions.code = "BAD_REQUEST";
          break;
        case ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED:
          extensions.code = "BAD_REQUEST";
          break;
        case ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND:
          extensions.code = "BAD_REQUEST";
          break;
        case ApolloServerErrorCode.PERSISTED_QUERY_NOT_SUPPORTED:
          extensions.code = "BAD_REQUEST";
          break;
        case ApolloServerErrorCode.BAD_USER_INPUT:
          extensions.code = "BAD_REQUEST";
          break;
        case ApolloServerErrorCode.OPERATION_RESOLUTION_FAILURE:
          extensions.code = "BAD_REQUEST";
          break;
        default:
          extensions.code = "INTERNAL";
          break;
      }

      if (extensions.code === "INTERNAL") {
        serverRootLogger.error("internal error response", {
          formattedError,
          error: unwrapResolverError(error),
        });
      }

      return {
        ...formattedError,
        extensions,
        message:
          extensions.code === "INTERNAL"
            ? "Internal error"
            : formattedError.message,
      };
    },
  });

  await apolloServer.start();

  // Health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Tracking pool REST API
  app.use(
    "/tracking-pool",
    createTrackingPoolRouter({ db: db as any, authSecret: AUTH_SECRET })
  );

  // GraphQL endpoint
  const appContext = createAppContext(carrierRegistry);
  app.use(
    GRAPHQL_PATH,
    expressMiddleware(apolloServer, {
      context: async ({ req, res }) => ({
        appContext,
      }),
    })
  );

  // Error handling middleware
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    serverRootLogger.error("Unhandled error", { error: err });
    res.status(500).json({ error: "Internal server error" });
  });

  // Start server
  const server = app.listen(PORT, () => {
    serverRootLogger.info(`🚀 Server ready at http://localhost:${PORT}`);
    serverRootLogger.info(`📊 GraphQL endpoint: http://localhost:${PORT}${GRAPHQL_PATH}`);
    serverRootLogger.info(`📦 Tracking Pool REST API: http://localhost:${PORT}/tracking-pool`);
  });

  // Initialize scheduler
  const scheduler = new Scheduler({ db: db as any, carrierRegistry, wooCommerceSync });
  scheduler.start();

  // Graceful shutdown
  const shutdown = () => {
    serverRootLogger.info("Shutting down...");
    scheduler.stop();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

initLogger();
main().catch((err) => {
  serverRootLogger.error("Uncaught error", {
    error: err,
  });
  process.exit(1);
});

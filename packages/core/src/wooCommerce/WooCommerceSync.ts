import { apiRootLogger } from "../logger";

export interface WooCommerceConfig {
  shopDomain: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooCommerceOrderStatus {
  id: number;
  status: string;
}

export class WooCommerceSync {
  private configs: Map<string, WooCommerceConfig> = new Map();

  addShop(config: WooCommerceConfig): void {
    this.configs.set(config.shopDomain, config);
  }

  getConfig(shopDomain: string): WooCommerceConfig | undefined {
    return this.configs.get(shopDomain);
  }

  async updateOrderStatus(
    orderId: number,
    status: string,
    shopDomain: string
  ): Promise<boolean> {
    const config = this.getConfig(shopDomain);
    if (!config) {
      apiRootLogger.error("WooCommerce config not found", { shopDomain });
      return false;
    }

    try {
      const credentials = Buffer.from(
        `${config.consumerKey}:${config.consumerSecret}`
      ).toString("base64");

      const response = await fetch(
        `https://${config.shopDomain}/wp-json/wc/v3/orders/${orderId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({ status }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        apiRootLogger.error("Failed to update WooCommerce order status", {
          orderId,
          status,
          shopDomain,
          response: errorText,
          statusCode: response.status,
        });
        return false;
      }

      apiRootLogger.info("WooCommerce order status updated", {
        orderId,
        status,
        shopDomain,
      });
      return true;
    } catch (error) {
      apiRootLogger.error("Error updating WooCommerce order status", {
        orderId,
        status,
        shopDomain,
        error,
      });
      return false;
    }
  }

  async getOrderStatus(
    orderId: number,
    shopDomain: string
  ): Promise<string | null> {
    const config = this.getConfig(shopDomain);
    if (!config) {
      apiRootLogger.error("WooCommerce config not found", { shopDomain });
      return null;
    }

    try {
      const credentials = Buffer.from(
        `${config.consumerKey}:${config.consumerSecret}`
      ).toString("base64");

      const response = await fetch(
        `https://${config.shopDomain}/wp-json/wc/v3/orders/${orderId}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
        }
      );

      if (!response.ok) {
        apiRootLogger.error("Failed to get WooCommerce order status", {
          orderId,
          shopDomain,
          statusCode: response.status,
        });
        return null;
      }

      const order = await response.json() as WooCommerceOrderStatus;
      return order.status;
    } catch (error) {
      apiRootLogger.error("Error getting WooCommerce order status", {
        orderId,
        shopDomain,
        error,
      });
      return null;
    }
  }
}

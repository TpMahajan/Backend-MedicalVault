import express from "express";
import { requireAdminAuth, requireAdminPermissions } from "../middleware/adminAuth.js";
import {
  adjustStock,
  confirmInventoryOrder,
  createOrder,
  getInventory,
  getInventoryOrders,
  restockProduct,
  updateOrderStatus,
} from "../controllers/inventoryController.js";

const router = express.Router();

router.get("/", getInventory);
router.get("/inventory", getInventory);
router.get(
  "/orders",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_ORDERS"),
  getInventoryOrders
);
router.post("/create-order", createOrder);
router.put(
  "/restock-product",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  restockProduct
);
router.put(
  "/adjust-stock",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  adjustStock
);
router.put(
  "/orders/:orderId/status",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_ORDERS"),
  updateOrderStatus
);

// Compatibility endpoint used by the earlier checkout flow.
router.post("/orders/confirm", confirmInventoryOrder);

export default router;

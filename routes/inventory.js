import express from "express";
import { requireAdminAuth } from "../middleware/adminAuth.js";
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
router.get("/orders", requireAdminAuth, getInventoryOrders);
router.post("/create-order", createOrder);
router.put("/restock-product", requireAdminAuth, restockProduct);
router.put("/adjust-stock", requireAdminAuth, adjustStock);
router.put("/orders/:orderId/status", requireAdminAuth, updateOrderStatus);

// Compatibility endpoint used by the earlier checkout flow.
router.post("/orders/confirm", confirmInventoryOrder);

export default router;

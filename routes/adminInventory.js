import express from "express";
import { requireAdminAuth, requireAdminPermissions } from "../middleware/adminAuth.js";
import {
  adjustInventory,
  getInventoryDashboard,
  getInventoryLedger,
  getInventoryProducts,
  processInventoryReturn,
  restockInventory,
  setInventoryReorderLevel,
} from "../controllers/inventoryController.js";

const router = express.Router();

router.get(
  "/dashboard",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  getInventoryDashboard
);
router.get(
  "/products",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  getInventoryProducts
);
router.get(
  "/ledger",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  getInventoryLedger
);

router.post(
  "/restock",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  restockInventory
);
router.post(
  "/adjust",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  adjustInventory
);
router.post(
  "/orders/:orderId/return",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_ORDERS"),
  processInventoryReturn
);
router.patch(
  "/products/:productKey/reorder-level",
  requireAdminAuth,
  requireAdminPermissions("MANAGE_PRODUCTS"),
  setInventoryReorderLevel
);

export default router;


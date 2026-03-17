import express from "express";
import { requireAdminAuth } from "../middleware/adminAuth.js";
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

router.get("/dashboard", requireAdminAuth, getInventoryDashboard);
router.get("/products", requireAdminAuth, getInventoryProducts);
router.get("/ledger", requireAdminAuth, getInventoryLedger);

router.post("/restock", requireAdminAuth, restockInventory);
router.post("/adjust", requireAdminAuth, adjustInventory);
router.post("/orders/:orderId/return", requireAdminAuth, processInventoryReturn);
router.patch(
  "/products/:productKey/reorder-level",
  requireAdminAuth,
  setInventoryReorderLevel
);

export default router;


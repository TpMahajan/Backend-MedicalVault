import {
  createInventoryOrder,
  getInventorySnapshot,
  getDashboardMetrics,
  getInventoryRows,
  getLedgerEntries,
  InventoryError,
  listInventoryOrders,
  updateInventoryOrderStatus,
  recordAdjustment,
  recordOrderConfirmation,
  recordRestock,
  recordReturnForOrder,
  updateProductReorderLevel,
} from "../services/inventoryService.js";

const handleInventoryError = (res, error, fallbackMessage) => {
  if (error instanceof InventoryError) {
    return res
      .status(error.statusCode || 400)
      .json({ success: false, message: error.message });
  }

  // Log full error so we can see it in the terminal
  console.error(`[Inventory 500] ${fallbackMessage}:`, error?.message || error);
  if (error?.stack) console.error(error.stack);

  return res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === "production"
      ? fallbackMessage
      : (error?.message || fallbackMessage),
  });
};

export const confirmInventoryOrder = async (req, res) => {
  try {
    const result = await recordOrderConfirmation(req.body || {});
    return res.status(200).json({
      success: true,
      message: result.idempotent
        ? "Inventory already synced for this order"
        : "Inventory updated for order confirmation",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(
      res,
      error,
      "Failed to process inventory order confirmation"
    );
  }
};

export const createOrder = async (req, res) => {
  try {
    const result = await createInventoryOrder(req.body || {});
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      message: result.idempotent
        ? "Order already exists"
        : "Order created and inventory reserved",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to create order");
  }
};

export const getInventory = async (req, res) => {
  try {
    const result = await getInventorySnapshot({
      productKey: req.query.productKey,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to fetch inventory");
  }
};

export const getInventoryDashboard = async (req, res) => {
  try {
    const result = await getDashboardMetrics({
      from: req.query.from,
      to: req.query.to,
      productKey: req.query.productKey,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return handleInventoryError(
      res,
      error,
      "Failed to fetch inventory dashboard data"
    );
  }
};

export const getInventoryProducts = async (req, res) => {
  try {
    const rows = await getInventoryRows({ productKey: req.query.productKey });
    return res.json({
      success: true,
      data: {
        rows,
      },
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to fetch inventory table data");
  }
};

export const getInventoryLedger = async (req, res) => {
  try {
    const result = await getLedgerEntries({
      from: req.query.from,
      to: req.query.to,
      productKey: req.query.productKey,
      movementType: req.query.movementType,
      page: req.query.page,
      limit: req.query.limit,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to fetch inventory ledger");
  }
};

export const restockInventory = async (req, res) => {
  try {
    const movement = await recordRestock({
      productKey: req.body?.productKey,
      quantity: req.body?.quantity,
      reason: req.body?.reason,
      referenceId: req.body?.referenceId,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Stock added successfully",
      data: movement,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to add stock");
  }
};

export const restockProduct = async (req, res) => {
  try {
    const result = await recordRestock({
      productKey: req.body?.productKey,
      quantity: req.body?.restockAmount ?? req.body?.quantity,
      reason: req.body?.reason,
      referenceId: req.body?.referenceId,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.json({
      success: true,
      message: "Product restocked successfully",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to restock product");
  }
};

export const adjustInventory = async (req, res) => {
  try {
    const movement = await recordAdjustment({
      productKey: req.body?.productKey,
      quantity: req.body?.quantity,
      reason: req.body?.reason,
      referenceId: req.body?.referenceId,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Stock adjusted successfully",
      data: movement,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to adjust stock");
  }
};

export const adjustStock = async (req, res) => {
  try {
    const result = await recordAdjustment({
      productKey: req.body?.productKey,
      quantity: req.body?.quantity,
      reason: req.body?.reason,
      referenceId: req.body?.referenceId,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.json({
      success: true,
      message: "Stock adjusted successfully",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to adjust stock");
  }
};

export const setInventoryReorderLevel = async (req, res) => {
  try {
    const updatedProduct = await updateProductReorderLevel({
      productKey: req.params.productKey,
      reorderLevel: req.body?.reorderLevel,
    });

    return res.json({
      success: true,
      message: "Reorder level updated",
      data: updatedProduct,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to update reorder level");
  }
};

export const getInventoryOrders = async (req, res) => {
  try {
    const orders = await listInventoryOrders({
      limit: req.query.limit,
    });

    return res.json({
      success: true,
      data: {
        orders,
      },
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to fetch inventory orders");
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const result = await updateInventoryOrderStatus({
      orderId: req.params.orderId,
      status: req.body?.status,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.json({
      success: true,
      message: "Order status updated",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to update order status");
  }
};

export const processInventoryReturn = async (req, res) => {
  try {
    const result = await recordReturnForOrder({
      orderId: req.params.orderId,
      reason: req.body?.reason,
      actor: {
        adminId: req.admin?._id || null,
        name: req.admin?.name || "Admin",
        source: "admin",
      },
    });

    return res.json({
      success: true,
      message: result.idempotent
        ? "Return already processed for this order"
        : "Return processed and stock restored",
      data: result,
    });
  } catch (error) {
    return handleInventoryError(res, error, "Failed to process return for order");
  }
};

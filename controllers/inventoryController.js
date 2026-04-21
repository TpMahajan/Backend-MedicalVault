import mongoose from "mongoose";

import { StoreOrder } from "../models/StoreOrder.js";
import {
  createInventoryOrder,
  getInventorySnapshot,
  getDashboardMetrics,
  getLedgerEntries,
  InventoryError,
  updateInventoryOrderStatus,
  recordAdjustment,
  recordOrderConfirmation,
  recordRestock,
  recordReturnForOrder,
  updateProductReorderLevel,
} from "../services/inventoryService.js";
import {
  applyInventoryForStoreOrderStatus,
  listInventoryRowsWithProductDetails,
  normalizeStoreOrderStatus,
  StoreInventoryError,
} from "../services/storeInventoryBridge.js";

const handleInventoryError = (res, error, fallbackMessage) => {
  if (error instanceof InventoryError) {
    return res
      .status(error.statusCode || 400)
      .json({ success: false, message: error.message });
  }
  if (error instanceof StoreInventoryError) {
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

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asText = (value) => (value == null ? "" : String(value).trim());

const STORE_GST_RATE = 0.18;
const STORE_BASE_DELIVERY_FEE = 40;
const STORE_FREE_DELIVERY_THRESHOLD = 599;

const computeStoreTotals = (totals = {}) => {
  const subtotal = Math.max(0, toNumber(totals?.subtotal, 0));
  const gst =
    toNumber(totals?.gst, Number((subtotal * STORE_GST_RATE).toFixed(2))) || 0;
  const deliveryCharges = Math.max(
    0,
    toNumber(
      totals?.deliveryCharges,
      subtotal >= STORE_FREE_DELIVERY_THRESHOLD ? 0 : STORE_BASE_DELIVERY_FEE
    )
  );
  const total = Math.max(
    0,
    toNumber(
      totals?.total,
      Number((subtotal + gst + deliveryCharges).toFixed(2))
    )
  );

  return {
    subtotal: Number(subtotal.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    deliveryCharges: Number(deliveryCharges.toFixed(2)),
    total: Number(total.toFixed(2)),
  };
};

const mapStoreStatusToAdmin = (status) => {
  const normalized = asText(status).toUpperCase();
  if (!normalized || normalized === "PLACED") return "Pending";
  if (normalized === "PROCESSING") return "Processing";
  if (normalized === "SHIPPED") return "Shipped";
  if (normalized === "DELIVERED") return "Delivered";
  if (normalized === "CANCELLED") return "Cancelled";
  if (normalized === "CONFIRMED") return "Confirmed";
  return "Pending";
};

const mapPaymentStatus = ({ method, status }) => {
  const normalizedStatus = asText(status).toUpperCase();
  if (normalizedStatus) return normalizedStatus;
  return asText(method).toLowerCase() === "cod" ? "PENDING_PAYMENT" : "PAID";
};

const mapStoreOrderForAdmin = (order) => {
  const totals = computeStoreTotals(order?.totals || {});
  const items = Array.isArray(order?.items)
    ? order.items.map((item) => ({
        id: asText(item?.productId || item?._id),
        name: asText(item?.name) || "Product",
        qty: Math.max(1, toNumber(item?.quantity, 1)),
        unitPrice: Math.max(0, toNumber(item?.unitPrice, 0)),
        imageUrl: asText(item?.imageUrl),
      }))
    : [];

  const delivery = order?.delivery || {};

  return {
    _id: order?._id?.toString?.() || asText(order?._id),
    orderId: order?._id?.toString?.() || asText(order?._id),
    date: order?.createdAt || new Date().toISOString(),
    status: mapStoreStatusToAdmin(order?.status),
    orderStatus: asText(order?.status).toUpperCase() || "PLACED",
    paymentMethod: asText(order?.paymentMethod || "cod").toLowerCase(),
    paymentStatus: mapPaymentStatus({
      method: order?.paymentMethod,
      status: order?.paymentStatus,
    }),
    subtotal: totals.subtotal,
    gst: totals.gst,
    deliveryCharges: totals.deliveryCharges,
    total: totals.total,
    items,
    address: {
      name: asText(delivery?.fullName) || "Customer",
      phone: asText(delivery?.phone),
      alternatePhone: asText(delivery?.alternatePhone),
      line1: asText(delivery?.addressLine1),
      line2: asText(delivery?.addressLine2),
      city: asText(delivery?.city),
      state: asText(delivery?.state),
      pin: asText(delivery?.pincode),
      notes: asText(delivery?.notes),
    },
    customerId: asText(order?.principalId),
    source: "store_order",
    createdAt: order?.createdAt || null,
    updatedAt: order?.updatedAt || null,
  };
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
    const rows = await listInventoryRowsWithProductDetails({
      productKey: req.query.productKey,
    });

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
      data: {
        ...movement,
        inventory: movement?.product || null,
      },
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
      data: {
        ...result,
        inventory: result?.product || null,
      },
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
      data: {
        ...movement,
        inventory: movement?.product || null,
      },
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
      data: {
        ...result,
        inventory: result?.product || null,
      },
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
    const limit = Math.min(
      500,
      Math.max(1, Math.floor(toNumber(req.query.limit, 200)))
    );

    const storeOrders = await StoreOrder.find({})
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const orders = storeOrders.map(mapStoreOrderForAdmin);

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
    const normalizedOrderId = String(req.params.orderId || "").trim();
    const normalizedStoreStatus = normalizeStoreOrderStatus(req.body?.status);

    if (mongoose.Types.ObjectId.isValid(normalizedOrderId)) {
      const storeOrder = await StoreOrder.findById(normalizedOrderId);
      if (storeOrder) {
        if (!normalizedStoreStatus) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid order status" });
        }

        await applyInventoryForStoreOrderStatus({
          order: storeOrder,
          nextStatus: normalizedStoreStatus,
        });
        storeOrder.status = normalizedStoreStatus;
        await storeOrder.save();

        return res.json({
          success: true,
          message: "Order status updated",
          data: {
            source: "store_order",
            order: storeOrder,
          },
        });
      }
    }

    const result = await updateInventoryOrderStatus({
      orderId: normalizedOrderId,
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

import mongoose from "mongoose";
import { InventoryMovement } from "../models/InventoryMovement.js";
import { InventoryOrder } from "../models/InventoryOrder.js";
import { InventoryProduct } from "../models/InventoryProduct.js";

export const INVENTORY_CATALOG = Object.freeze([
  {
    productKey: "NFC_BAND",
    productName: "NFC Band",
    sku: "NFC-BAND-001",
    productId: "band-1",
    unitPrice: 600,
    reorderLevel: 20,
  },
  {
    productKey: "MEDICAL_KIT",
    productName: "Medical Kit",
    sku: "MED-KIT-001",
    productId: "kit-1",
    unitPrice: 1000,
    reorderLevel: 15,
  },
]);

const CATALOG_BY_KEY = new Map(
  INVENTORY_CATALOG.map((product) => [product.productKey, product])
);
const CATALOG_BY_PRODUCT_ID = new Map(
  INVENTORY_CATALOG.map((product) => [product.productId.toLowerCase(), product])
);
const CATALOG_BY_SKU = new Map(
  INVENTORY_CATALOG.map((product) => [product.sku.toLowerCase(), product])
);

const MOVEMENT_TYPES = new Set(["IN", "OUT", "RETURN", "DAMAGED", "ADJUSTMENT"]);
const COMPLETED_STATUSES = new Set(["completed", "delivered"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);

export class InventoryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "InventoryError";
    this.statusCode = statusCode;
  }
}

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toInteger = (value, fallback = 0) =>
  Math.max(0, Math.floor(toNumber(value, fallback)));

const toDate = (value, fallback = new Date()) => {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
};

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const startOfWeek = (value) => {
  const date = startOfDay(value);
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return date;
};

const buildActor = (actor, fallbackSource = "system") => ({
  adminId: actor?.adminId || actor?._id || null,
  name: actor?.name || "System",
  source: actor?.source || fallbackSource,
});

const normalizeProductKeyValue = (value) => {
  if (!value && value !== 0) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (CATALOG_BY_KEY.has(upper)) return upper;

  const lower = raw.toLowerCase();
  if (CATALOG_BY_PRODUCT_ID.has(lower)) {
    return CATALOG_BY_PRODUCT_ID.get(lower).productKey;
  }
  if (CATALOG_BY_SKU.has(lower)) {
    return CATALOG_BY_SKU.get(lower).productKey;
  }

  if (lower.includes("nfc") || lower.includes("healthband") || lower.includes("band")) {
    return "NFC_BAND";
  }
  if (
    lower.includes("medical kit") ||
    lower.includes("smart medical kit") ||
    lower.includes("kit")
  ) {
    return "MEDICAL_KIT";
  }

  return null;
};

const computeInventoryStatus = (availableStock) =>
  toNumber(availableStock, 0) > 0 ? "IN_STOCK" : "OUT_OF_STOCK";

const computeRowStatus = (availableStock, reorderLevel) => {
  if (availableStock <= 0) return "Out";
  if (availableStock <= reorderLevel) return "Low";
  return "In Stock";
};

const mapInventoryProduct = (product) => {
  const totalStock = toInteger(product?.totalStock, 0);
  const reservedStock = Math.min(totalStock, toInteger(product?.reservedStock, 0));
  const availableStock = Math.max(
    0,
    product?.availableStock == null
      ? totalStock - reservedStock
      : toInteger(product?.availableStock, totalStock - reservedStock)
  );

  return {
    _id: product?._id,
    productKey: product?.productKey,
    productId: product?._id,
    externalProductId: product?.productId || "",
    productName: product?.productName || product?.name || product?.productKey,
    totalStock,
    reservedStock,
    availableStock,
    reorderLevel: toInteger(product?.reorderLevel, 0),
    lastRestocked: product?.lastRestocked || product?.lastRestockedAt || null,
    status: computeInventoryStatus(availableStock),
    lowStock: availableStock <= toInteger(product?.reorderLevel, 0),
    sku: product?.sku || "",
    unitPrice: toNumber(product?.unitPrice, 0),
  };
};

const mapInventoryRow = (product) => {
  const normalized = mapInventoryProduct(product);
  return {
    productKey: normalized.productKey,
    productId: normalized.productId,
    externalProductId: normalized.externalProductId,
    product: normalized.productName,
    productName: normalized.productName,
    sku: normalized.sku,
    unitPrice: normalized.unitPrice,
    currentStock: normalized.totalStock,
    totalStock: normalized.totalStock,
    reservedStock: normalized.reservedStock,
    availableStock: normalized.availableStock,
    reorderLevel: normalized.reorderLevel,
    lastRestocked: normalized.lastRestocked,
    inventoryStatus: normalized.status,
    lowStock: normalized.lowStock,
    status: computeRowStatus(normalized.availableStock, normalized.reorderLevel),
  };
};

const mapOrderRecord = (order) => ({
  _id: order?._id,
  orderId: order?.orderId,
  productId: order?.productId || null,
  quantity: toInteger(order?.quantity, 1),
  orderStatus: order?.orderStatus || "PENDING",
  status: order?.status || "Confirmed",
  paymentMethod: order?.paymentMethod || "",
  paymentStatus: order?.paymentStatus || "",
  total: toNumber(order?.total, 0),
  source: order?.source || "web_checkout",
  orderDate: order?.orderDate || order?.createdAt || null,
  items: Array.isArray(order?.items) ? order.items : [],
  completedAt: order?.completedAt || null,
  returnProcessedAt: order?.returnProcessedAt || null,
  createdAt: order?.createdAt || null,
  updatedAt: order?.updatedAt || null,
});

const buildInventoryResponse = (products) => ({
  products: products.map(mapInventoryProduct),
});

export const isPendingOrderStatus = (status, orderStatus = "PENDING") => {
  if (String(orderStatus || "").trim().toUpperCase() === "COMPLETED") return false;

  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return true;

  return ["pending", "placed", "confirmed", "processing", "shipped"].includes(
    normalized
  );
};

export const calculateSignedStockDelta = (
  movementType,
  quantity,
  adjustmentSign = 1
) => {
  const qty = Math.abs(toNumber(quantity, 0));
  if (!qty) return 0;

  switch (movementType) {
    case "IN":
    case "RETURN":
      return qty;
    case "OUT":
    case "DAMAGED":
      return -qty;
    case "ADJUSTMENT":
      return qty * (toNumber(adjustmentSign, 1) >= 0 ? 1 : -1);
    default:
      return 0;
  }
};

export const calculateRevenueDelta = (movement) => {
  const amountFromUnit =
    toNumber(movement?.unitPrice, 0) * Math.abs(toNumber(movement?.quantity, 0));
  const amount = toNumber(movement?.amount, amountFromUnit);
  if (!amount) return 0;

  if (movement?.movementType === "OUT") return amount;
  if (movement?.movementType === "RETURN") return -amount;
  return 0;
};

export const normalizeDateRange = ({ from, to, defaultDays = 30 } = {}) => {
  const now = new Date();
  const defaultFrom = startOfDay(
    new Date(now.getTime() - (defaultDays - 1) * 24 * 60 * 60 * 1000)
  );
  const rangeStart = from ? startOfDay(toDate(from, defaultFrom)) : defaultFrom;
  const rangeEnd = to ? endOfDay(toDate(to, now)) : endOfDay(now);

  if (rangeStart <= rangeEnd) {
    return { start: rangeStart, end: rangeEnd };
  }
  return { start: startOfDay(rangeEnd), end: endOfDay(rangeStart) };
};

export const sanitizeOrderItems = (items) => {
  if (!Array.isArray(items) || !items.length) {
    throw new InventoryError("Order items are required", 400);
  }

  const merged = new Map();

  for (const item of items) {
    const productKey =
      normalizeProductKeyValue(item?.productKey) ||
      normalizeProductKeyValue(item?.productId) ||
      normalizeProductKeyValue(item?.id) ||
      normalizeProductKeyValue(item?.sku) ||
      normalizeProductKeyValue(item?.name);

    if (!productKey) {
      throw new InventoryError("Unsupported product found in order payload", 400);
    }

    const quantityRaw = Math.floor(toNumber(item?.qty ?? item?.quantity, 0));
    if (quantityRaw <= 0) continue;

    const catalogEntry = CATALOG_BY_KEY.get(productKey);
    const unitPrice = Math.max(
      0,
      toNumber(item?.unitPrice, catalogEntry?.unitPrice ?? 0)
    );

    const existing = merged.get(productKey);
    if (existing) {
      existing.quantity += quantityRaw;
      if (!existing.unitPrice && unitPrice) existing.unitPrice = unitPrice;
    } else {
      merged.set(productKey, {
        productKey,
        productId: item?.productId || catalogEntry?.productId || "",
        name: item?.name || catalogEntry?.productName || productKey,
        quantity: quantityRaw,
        unitPrice,
      });
    }
  }

  const normalizedItems = Array.from(merged.values());
  if (!normalizedItems.length) {
    throw new InventoryError("No valid order items found for inventory processing", 400);
  }
  return normalizedItems;
};

export const ensureInventoryProducts = async (productModel = InventoryProduct) => {
  for (const product of INVENTORY_CATALOG) {
    await productModel.findOneAndUpdate(
      { productKey: product.productKey },
      {
        $setOnInsert: {
          productKey: product.productKey,
          reorderLevel: product.reorderLevel,
          totalStock: 0,
          reservedStock: 0,
          availableStock: 0,
          status: "OUT_OF_STOCK",
          isActive: true,
          lastRestocked: null,
          lastRestockedAt: null,
        },
        $set: {
          productName: product.productName,
          name: product.productName,
          sku: product.sku,
          productId: product.productId,
          unitPrice: product.unitPrice,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const products = await productModel
    .find({
      productKey: { $in: INVENTORY_CATALOG.map((product) => product.productKey) },
    })
    .sort({ productName: 1, createdAt: 1 });

  for (const product of products) {
    const catalogEntry = CATALOG_BY_KEY.get(product.productKey);
    if (!catalogEntry) continue;

    let requiresSave = false;

    if (product.productName !== catalogEntry.productName) {
      product.productName = catalogEntry.productName;
      requiresSave = true;
    }
    if (product.name !== catalogEntry.productName) {
      product.name = catalogEntry.productName;
      requiresSave = true;
    }
    if (product.sku !== catalogEntry.sku) {
      product.sku = catalogEntry.sku;
      requiresSave = true;
    }
    if (product.productId !== catalogEntry.productId) {
      product.productId = catalogEntry.productId;
      requiresSave = true;
    }
    if (toNumber(product.unitPrice, catalogEntry.unitPrice) !== catalogEntry.unitPrice) {
      product.unitPrice = catalogEntry.unitPrice;
      requiresSave = true;
    }
    if (product.reorderLevel == null || toNumber(product.reorderLevel, -1) < 0) {
      product.reorderLevel = catalogEntry.reorderLevel;
      requiresSave = true;
    }
    if (product.totalStock == null) {
      product.totalStock = 0;
      requiresSave = true;
    }
    if (product.reservedStock == null) {
      product.reservedStock = 0;
      requiresSave = true;
    }
    if (product.lastRestocked == null && product.lastRestockedAt != null) {
      product.lastRestocked = product.lastRestockedAt;
      requiresSave = true;
    }
    if (product.lastRestockedAt == null && product.lastRestocked != null) {
      product.lastRestockedAt = product.lastRestocked;
      requiresSave = true;
    }
    if (product.isActive == null) {
      product.isActive = true;
      requiresSave = true;
    }

    if (requiresSave) {
      await product.save();
    }
  }

  return productModel.find({
    productKey: { $in: INVENTORY_CATALOG.map((product) => product.productKey) },
  });
};

const normalizeMovementInput = ({ movementType, quantity, reason, productKey }) => {
  const normalizedType = String(movementType || "").trim().toUpperCase();
  if (!MOVEMENT_TYPES.has(normalizedType)) {
    throw new InventoryError("Invalid movement type", 400);
  }

  const normalizedProductKey = normalizeProductKeyValue(productKey);
  if (!normalizedProductKey) {
    throw new InventoryError("Invalid product key", 400);
  }

  const reasonText = String(reason || "").trim();
  if (!reasonText) {
    throw new InventoryError("Movement reason is required", 400);
  }

  const rawQuantity = toNumber(quantity, 0);
  if (!rawQuantity) {
    throw new InventoryError("Quantity must be non-zero", 400);
  }

  let normalizedQuantity = Math.abs(Math.floor(rawQuantity));
  if (!normalizedQuantity) {
    throw new InventoryError("Quantity must be at least 1", 400);
  }

  let adjustmentSign = null;
  if (normalizedType === "ADJUSTMENT") {
    adjustmentSign = rawQuantity < 0 ? -1 : 1;
  } else if (rawQuantity < 0) {
    throw new InventoryError("Quantity cannot be negative for this movement type", 400);
  }

  return {
    movementType: normalizedType,
    productKey: normalizedProductKey,
    quantity: normalizedQuantity,
    adjustmentSign,
    reason: reasonText,
  };
};

const createMovement = async (
  payload,
  { movementModel = InventoryMovement, productModel = InventoryProduct } = {}
) => {
  const happenedAt = toDate(payload?.happenedAt, new Date());
  const actor = buildActor(payload?.actor, "system");

  const movementData = {
    productKey: payload.productKey,
    movementType: payload.movementType,
    quantity: Math.abs(toInteger(payload.quantity, 0)),
    adjustmentSign: payload.adjustmentSign ?? null,
    reason: payload.reason,
    happenedAt,
    createdBy: actor,
    metadata: payload?.metadata ?? null,
  };

  if (payload?.referenceId) movementData.referenceId = String(payload.referenceId).trim();
  if (payload?.idempotencyKey) {
    movementData.idempotencyKey = String(payload.idempotencyKey).trim();
  }
  if (payload?.unitPrice != null) {
    movementData.unitPrice = Math.max(0, toNumber(payload.unitPrice, 0));
  }
  if (payload?.amount != null) {
    movementData.amount = Math.max(0, toNumber(payload.amount, 0));
  }

  const movement = await movementModel.create(movementData);

  if (payload.movementType === "IN") {
    await productModel.updateOne(
      { productKey: payload.productKey },
      { $set: { lastRestocked: happenedAt, lastRestockedAt: happenedAt } }
    );
  }

  return movement;
};

const updateProductWithPipeline = async (
  filter,
  pipeline,
  { productModel = InventoryProduct } = {}
) =>
  productModel.findOneAndUpdate(filter, pipeline, {
    new: true,
    runValidators: true,
  });

const reserveInventoryForItem = async (item, deps = {}) => {
  const updated = await updateProductWithPipeline(
    {
      _id: item.productRef,
      availableStock: { $gte: item.quantity },
    },
    [
      {
        $set: {
          reservedStock: { $add: ["$reservedStock", item.quantity] },
          availableStock: { $subtract: ["$availableStock", item.quantity] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    deps
  );

  if (!updated) {
    throw new InventoryError(
      `Insufficient available stock for ${item.name || item.productKey}`,
      409
    );
  }

  return updated;
};

const releaseReservedInventoryForItem = async (item, deps = {}) => {
  const updated = await updateProductWithPipeline(
    {
      _id: item.productRef,
      reservedStock: { $gte: item.quantity },
    },
    [
      {
        $set: {
          reservedStock: { $subtract: ["$reservedStock", item.quantity] },
          availableStock: { $add: ["$availableStock", item.quantity] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    deps
  );

  if (!updated) {
    throw new InventoryError(
      `Unable to release reserved stock for ${item.name || item.productKey}`,
      409
    );
  }

  return updated;
};

const completeInventoryForItem = async (item, deps = {}) => {
  const updated = await updateProductWithPipeline(
    {
      _id: item.productRef,
      reservedStock: { $gte: item.quantity },
      totalStock: { $gte: item.quantity },
    },
    [
      {
        $set: {
          reservedStock: { $subtract: ["$reservedStock", item.quantity] },
          totalStock: { $subtract: ["$totalStock", item.quantity] },
        },
      },
      {
        $set: {
          availableStock: { $subtract: ["$totalStock", "$reservedStock"] },
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    deps
  );

  if (!updated) {
    throw new InventoryError(
      `Unable to complete stock deduction for ${item.name || item.productKey}`,
      409
    );
  }

  return updated;
};

const rollbackCompletedInventoryForItem = async (item, deps = {}) => {
  const updated = await updateProductWithPipeline(
    {
      _id: item.productRef,
    },
    [
      {
        $set: {
          reservedStock: { $add: ["$reservedStock", item.quantity] },
          totalStock: { $add: ["$totalStock", item.quantity] },
        },
      },
      {
        $set: {
          availableStock: { $subtract: ["$totalStock", "$reservedStock"] },
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    deps
  );

  if (!updated) {
    throw new InventoryError(
      `Unable to roll back completed stock for ${item.name || item.productKey}`,
      409
    );
  }

  return updated;
};

const restockCompletedInventoryForItem = async (item, deps = {}) => {
  const updated = await updateProductWithPipeline(
    {
      _id: item.productRef,
    },
    [
      {
        $set: {
          totalStock: { $add: ["$totalStock", item.quantity] },
          availableStock: { $add: ["$availableStock", item.quantity] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    deps
  );

  if (!updated) {
    throw new InventoryError(
      `Unable to restock returned units for ${item.name || item.productKey}`,
      409
    );
  }

  return updated;
};

const listSnapshotProducts = async (
  { productKey } = {},
  { productModel = InventoryProduct } = {}
) => {
  const normalizedProductKey = productKey
    ? normalizeProductKeyValue(productKey)
    : null;

  if (productKey && !normalizedProductKey) {
    throw new InventoryError("Invalid product key", 400);
  }

  await ensureInventoryProducts(productModel);

  const filter = normalizedProductKey ? { productKey: normalizedProductKey } : {};
  return productModel.find(filter).sort({ productName: 1, createdAt: 1 }).lean();
};

const buildOrderItemsPayload = (payload) => {
  if (Array.isArray(payload?.items) && payload.items.length) {
    return payload.items;
  }

  if (payload?.productId || payload?.productKey || payload?.name) {
    return [
      {
        productId: payload.productId,
        productKey: payload.productKey,
        quantity: payload.quantity,
        qty: payload.qty,
        unitPrice: payload.unitPrice,
        name: payload.name || payload.productName,
      },
    ];
  }

  return [];
};

const resolveInventoryProductForItem = async (
  rawItem,
  { productModel = InventoryProduct } = {}
) => {
  const directProductId = String(rawItem?.productId || "").trim();
  if (
    directProductId &&
    mongoose.Types.ObjectId.isValid(directProductId) &&
    !normalizeProductKeyValue(directProductId)
  ) {
    return productModel.findById(directProductId);
  }

  const productKey =
    normalizeProductKeyValue(rawItem?.productKey) ||
    normalizeProductKeyValue(rawItem?.productId) ||
    normalizeProductKeyValue(rawItem?.id) ||
    normalizeProductKeyValue(rawItem?.sku) ||
    normalizeProductKeyValue(rawItem?.name);

  if (!productKey) return null;
  return productModel.findOne({ productKey });
};

const resolveOrderItems = async (
  payload,
  { productModel = InventoryProduct } = {}
) => {
  await ensureInventoryProducts(productModel);

  const rawItems = buildOrderItemsPayload(payload);
  if (!rawItems.length) {
    throw new InventoryError("Order items are required", 400);
  }

  const merged = new Map();

  for (const rawItem of rawItems) {
    const quantity = Math.floor(toNumber(rawItem?.qty ?? rawItem?.quantity, 0));
    if (quantity <= 0) continue;

    const product = await resolveInventoryProductForItem(rawItem, { productModel });
    if (!product) {
      throw new InventoryError("Product not found for order item", 404);
    }

    const cacheKey = String(product._id);
    const unitPrice = Math.max(0, toNumber(rawItem?.unitPrice, product.unitPrice));

    if (merged.has(cacheKey)) {
      merged.get(cacheKey).quantity += quantity;
      continue;
    }

    merged.set(cacheKey, {
      productRef: product._id,
      productKey: product.productKey,
      productId: product.productId,
      name: rawItem?.name || product.productName || product.name,
      quantity,
      unitPrice,
    });
  }

  const items = Array.from(merged.values());
  if (!items.length) {
    throw new InventoryError("No valid order items found for inventory processing", 400);
  }

  return items;
};

const resolveStoredOrderItems = async (
  order,
  { productModel = InventoryProduct } = {}
) => {
  if (!Array.isArray(order?.items) || !order.items.length) {
    throw new InventoryError("Order items are missing", 400);
  }

  await ensureInventoryProducts(productModel);

  const merged = new Map();
  for (const item of order.items) {
    const product =
      item?.productRef && mongoose.Types.ObjectId.isValid(String(item.productRef))
        ? await productModel.findById(item.productRef)
        : await productModel.findOne({
            productKey: normalizeProductKeyValue(item?.productKey || item?.productId || item?.name),
          });

    if (!product) {
      throw new InventoryError("Order item references an unknown product", 404);
    }

    const cacheKey = String(product._id);
    const quantity = Math.max(1, toInteger(item?.quantity, 1));
    const unitPrice = Math.max(0, toNumber(item?.unitPrice, product.unitPrice));

    if (merged.has(cacheKey)) {
      merged.get(cacheKey).quantity += quantity;
      continue;
    }

    merged.set(cacheKey, {
      productRef: product._id,
      productKey: product.productKey,
      productId: product.productId,
      name: item?.name || product.productName || product.name,
      quantity,
      unitPrice,
    });
  }

  return Array.from(merged.values());
};

export const recordManualMovement = async (payload, deps = {}) => {
  const { movementType, productKey, quantity, adjustmentSign, reason } =
    normalizeMovementInput(payload || {});

  await ensureInventoryProducts(deps.productModel || InventoryProduct);

  return createMovement(
    {
      movementType,
      productKey,
      quantity,
      adjustmentSign,
      reason,
      referenceId: payload?.referenceId,
      idempotencyKey: payload?.idempotencyKey,
      happenedAt: payload?.happenedAt,
      unitPrice: payload?.unitPrice,
      amount: payload?.amount,
      actor: payload?.actor,
      metadata: payload?.metadata ?? null,
    },
    deps
  );
};

export const recordRestock = async (
  { productKey, quantity, reason, referenceId, actor },
  { productModel = InventoryProduct, movementModel = InventoryMovement } = {}
) => {
  const normalizedProductKey = normalizeProductKeyValue(productKey);
  if (!normalizedProductKey) {
    throw new InventoryError("Invalid product key", 400);
  }

  const qty = Math.max(1, toInteger(quantity, 0));
  if (!qty) {
    throw new InventoryError("Restock quantity must be at least 1", 400);
  }

  const reasonText = String(reason || "").trim() || "Manual restock";
  const happenedAt = new Date();

  await ensureInventoryProducts(productModel);

  const updatedProduct = await updateProductWithPipeline(
    { productKey: normalizedProductKey },
    [
      {
        $set: {
          totalStock: { $add: ["$totalStock", qty] },
          availableStock: { $add: ["$availableStock", qty] },
          lastRestocked: happenedAt,
          lastRestockedAt: happenedAt,
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ],
    { productModel }
  );

  if (!updatedProduct) {
    throw new InventoryError("Inventory product not found", 404);
  }

  const movement = await createMovement(
    {
      movementType: "IN",
      productKey: normalizedProductKey,
      quantity: qty,
      reason: reasonText,
      referenceId,
      happenedAt,
      actor,
      metadata: { operation: "restock" },
    },
    { movementModel, productModel }
  );

  return {
    movement,
    product: mapInventoryProduct(updatedProduct),
  };
};

export const recordAdjustment = async (
  { productKey, quantity, reason, referenceId, actor },
  { productModel = InventoryProduct, movementModel = InventoryMovement } = {}
) => {
  const normalizedProductKey = normalizeProductKeyValue(productKey);
  if (!normalizedProductKey) {
    throw new InventoryError("Invalid product key", 400);
  }

  const signedQuantity = Math.trunc(toNumber(quantity, 0));
  if (!signedQuantity) {
    throw new InventoryError("Adjustment quantity must be non-zero", 400);
  }

  const reasonText = String(reason || "").trim() || "Manual stock adjustment";
  const happenedAt = new Date();
  const quantityAbs = Math.abs(signedQuantity);
  const filter = { productKey: normalizedProductKey };
  let pipeline;

  await ensureInventoryProducts(productModel);

  if (signedQuantity > 0) {
    pipeline = [
      {
        $set: {
          totalStock: { $add: ["$totalStock", quantityAbs] },
          availableStock: { $add: ["$availableStock", quantityAbs] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ];
  } else {
    filter.availableStock = { $gte: quantityAbs };
    filter.totalStock = { $gte: quantityAbs };
    pipeline = [
      {
        $set: {
          totalStock: { $subtract: ["$totalStock", quantityAbs] },
          availableStock: { $subtract: ["$availableStock", quantityAbs] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gt: ["$availableStock", 0] }, "IN_STOCK", "OUT_OF_STOCK"],
          },
        },
      },
    ];
  }

  const updatedProduct = await updateProductWithPipeline(filter, pipeline, {
    productModel,
  });

  if (!updatedProduct) {
    throw new InventoryError("Unable to adjust stock with the requested quantity", 409);
  }

  const movement = await createMovement(
    {
      movementType: "ADJUSTMENT",
      productKey: normalizedProductKey,
      quantity: quantityAbs,
      adjustmentSign: signedQuantity > 0 ? 1 : -1,
      reason: reasonText,
      referenceId,
      happenedAt,
      actor,
      metadata: { operation: "adjustment" },
    },
    { movementModel, productModel }
  );

  return {
    movement,
    product: mapInventoryProduct(updatedProduct),
  };
};

export const updateProductReorderLevel = async (
  { productKey, reorderLevel },
  { productModel = InventoryProduct } = {}
) => {
  const normalizedProductKey = normalizeProductKeyValue(productKey);
  if (!normalizedProductKey) {
    throw new InventoryError("Invalid product key", 400);
  }

  const normalizedReorder = Math.floor(toNumber(reorderLevel, -1));
  if (normalizedReorder < 0) {
    throw new InventoryError("Reorder level must be 0 or greater", 400);
  }

  await ensureInventoryProducts(productModel);

  const updated = await productModel.findOneAndUpdate(
    { productKey: normalizedProductKey },
    { $set: { reorderLevel: normalizedReorder } },
    { new: true }
  );

  if (!updated) {
    throw new InventoryError("Inventory product not found", 404);
  }

  return mapInventoryProduct(updated);
};

export const getInventorySnapshot = async (
  { productKey } = {},
  { productModel = InventoryProduct } = {}
) => {
  const products = await listSnapshotProducts({ productKey }, { productModel });
  return buildInventoryResponse(products);
};

export const createInventoryOrder = async (
  payload,
  {
    productModel = InventoryProduct,
    movementModel = InventoryMovement,
    orderModel = InventoryOrder,
  } = {}
) => {
  const orderId = String(
    payload?.orderId || `MV-${Date.now().toString().slice(-7)}`
  ).trim();

  if (!orderId) {
    throw new InventoryError("orderId is required", 400);
  }

  const existingOrder = await orderModel.findOne({ orderId }).lean();
  if (existingOrder) {
    return {
      order: mapOrderRecord(existingOrder),
      inventory: await getInventorySnapshot({}, { productModel }),
      idempotent: true,
    };
  }

  const orderItems = await resolveOrderItems(payload, { productModel });
  const orderDate = toDate(payload?.date || payload?.orderDate, new Date());
  const actor = buildActor(payload?.actor, "checkout");
  const reservedItems = [];

  try {
    for (const item of orderItems) {
      await reserveInventoryForItem(item, { productModel });
      reservedItems.push(item);
    }

    const totalQuantity = orderItems.reduce((sum, item) => sum + item.quantity, 0);
    const primaryItem = orderItems[0];

    const order = await orderModel.create({
      orderId,
      productId: primaryItem.productRef,
      quantity: totalQuantity,
      orderStatus: "PENDING",
      status: payload?.status || "Confirmed",
      paymentMethod: payload?.paymentMethod || "",
      paymentStatus: payload?.paymentStatus || "",
      total: Math.max(0, toNumber(payload?.total, 0)),
      source: payload?.source || "web_checkout",
      orderDate,
      items: orderItems.map((item) => ({
        productRef: item.productRef,
        productKey: item.productKey,
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    });

    for (const item of orderItems) {
      const idempotencyKey = `order-out:${orderId}:${item.productKey}`;
      await movementModel.updateOne(
        { idempotencyKey },
        {
          $setOnInsert: {
            productKey: item.productKey,
            movementType: "OUT",
            quantity: item.quantity,
            reason: "Order placed - stock reserved",
            referenceId: orderId,
            unitPrice: item.unitPrice,
            amount: item.unitPrice * item.quantity,
            idempotencyKey,
            happenedAt: orderDate,
            createdBy: actor,
            metadata: {
              operation: "order_create",
              orderStatus: "PENDING",
            },
          },
        },
        { upsert: true }
      );
    }

    return {
      order: mapOrderRecord(order),
      inventory: await getInventorySnapshot({}, { productModel }),
      idempotent: false,
    };
  } catch (error) {
    for (const item of reservedItems.reverse()) {
      try {
        await releaseReservedInventoryForItem(item, { productModel });
      } catch (rollbackError) {
        console.error("Inventory rollback failed:", rollbackError);
      }
    }
    throw error;
  }
};

export const recordOrderConfirmation = async (payload, deps = {}) => {
  const result = await createInventoryOrder(payload?.order ? payload.order : payload, deps);

  return {
    orderId: result.order.orderId,
    items: result.order.items,
    createdMovements: result.idempotent ? 0 : result.order.items.length,
    duplicateMovements: result.idempotent ? result.order.items.length : 0,
    idempotent: result.idempotent,
  };
};

export const completeInventoryOrder = async (
  { orderId, status = "Delivered" },
  {
    productModel = InventoryProduct,
    orderModel = InventoryOrder,
  } = {}
) => {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    throw new InventoryError("orderId is required", 400);
  }

  const order = await orderModel.findOne({ orderId: normalizedOrderId });
  if (!order) {
    throw new InventoryError("Order not found", 404);
  }

  if (String(order.orderStatus || "").toUpperCase() === "COMPLETED") {
    return {
      order: mapOrderRecord(order),
      inventory: await getInventorySnapshot({}, { productModel }),
      idempotent: true,
    };
  }

  const orderItems = await resolveStoredOrderItems(order, { productModel });
  const completedItems = [];

  try {
    for (const item of orderItems) {
      await completeInventoryForItem(item, { productModel });
      completedItems.push(item);
    }

    order.orderStatus = "COMPLETED";
    order.status = status;
    order.completedAt = new Date();
    await order.save();

    return {
      order: mapOrderRecord(order),
      inventory: await getInventorySnapshot({}, { productModel }),
      idempotent: false,
    };
  } catch (error) {
    for (const item of completedItems.reverse()) {
      try {
        await rollbackCompletedInventoryForItem(item, { productModel });
      } catch (rollbackError) {
        console.error("Inventory completion rollback failed:", rollbackError);
      }
    }
    throw error;
  }
};

const cancelPendingInventoryOrder = async (
  { orderId, status = "Cancelled", actor },
  {
    productModel = InventoryProduct,
    movementModel = InventoryMovement,
    orderModel = InventoryOrder,
  } = {}
) => {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    throw new InventoryError("orderId is required", 400);
  }

  const order = await orderModel.findOne({ orderId: normalizedOrderId });
  if (!order) {
    throw new InventoryError("Order not found", 404);
  }

  if (String(order.orderStatus || "").toUpperCase() === "COMPLETED") {
    throw new InventoryError(
      "Completed orders cannot be cancelled. Process a return instead.",
      409
    );
  }

  if (CANCELLED_STATUSES.has(String(order.status || "").trim().toLowerCase())) {
    return {
      order: mapOrderRecord(order),
      inventory: await getInventorySnapshot({}, { productModel }),
      idempotent: true,
    };
  }

  const orderItems = await resolveStoredOrderItems(order, { productModel });

  for (const item of orderItems) {
    await releaseReservedInventoryForItem(item, { productModel });

    const idempotencyKey = `order-cancel:${normalizedOrderId}:${item.productKey}`;
    await movementModel.updateOne(
      { idempotencyKey },
      {
        $setOnInsert: {
          productKey: item.productKey,
          movementType: "RETURN",
          quantity: item.quantity,
          reason: "Order cancelled - stock released",
          referenceId: normalizedOrderId,
          unitPrice: item.unitPrice,
          amount: item.unitPrice * item.quantity,
          idempotencyKey,
          happenedAt: new Date(),
          createdBy: buildActor(actor, "admin"),
          metadata: {
            operation: "order_cancel",
          },
        },
      },
      { upsert: true }
    );
  }

  order.status = status;
  await order.save();

  return {
    order: mapOrderRecord(order),
    inventory: await getInventorySnapshot({}, { productModel }),
    idempotent: false,
  };
};

export const updateInventoryOrderStatus = async (
  { orderId, status, actor },
  deps = {}
) => {
  const normalizedStatus = String(status || "").trim();
  if (!normalizedStatus) {
    throw new InventoryError("status is required", 400);
  }

  const lowerStatus = normalizedStatus.toLowerCase();
  if (COMPLETED_STATUSES.has(lowerStatus)) {
    return completeInventoryOrder(
      {
        orderId,
        status:
          normalizedStatus.toLowerCase() === "completed"
            ? "Completed"
            : "Delivered",
      },
      deps
    );
  }

  if (CANCELLED_STATUSES.has(lowerStatus)) {
    return cancelPendingInventoryOrder(
      { orderId, status: "Cancelled", actor },
      deps
    );
  }

  const order = await (deps.orderModel || InventoryOrder).findOneAndUpdate(
    { orderId: String(orderId || "").trim() },
    { $set: { status: normalizedStatus } },
    { new: true }
  );

  if (!order) {
    throw new InventoryError("Order not found", 404);
  }

  return {
    order: mapOrderRecord(order),
    inventory: await getInventorySnapshot({}, {
      productModel: deps.productModel || InventoryProduct,
    }),
    idempotent: false,
  };
};

export const recordReturnForOrder = async (
  { orderId, reason, actor },
  {
    productModel = InventoryProduct,
    movementModel = InventoryMovement,
    orderModel = InventoryOrder,
  } = {}
) => {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId) {
    throw new InventoryError("orderId is required", 400);
  }

  const order = await orderModel.findOne({ orderId: normalizedOrderId });
  if (!order) {
    throw new InventoryError("Order not found in inventory records", 404);
  }

  if (order.returnProcessedAt) {
    return {
      orderId: normalizedOrderId,
      createdMovements: 0,
      duplicateMovements: Array.isArray(order.items) ? order.items.length : 0,
      idempotent: true,
    };
  }

  const orderItems = await resolveStoredOrderItems(order, { productModel });
  const actorPayload = buildActor(actor, "admin");
  const movementReason =
    String(reason || "").trim() || "Order cancelled/refunded";

  for (const item of orderItems) {
    if (String(order.orderStatus || "").toUpperCase() === "COMPLETED") {
      await restockCompletedInventoryForItem(item, { productModel });
    } else {
      await releaseReservedInventoryForItem(item, { productModel });
    }

    const idempotencyKey = `order-return:${normalizedOrderId}:${item.productKey}`;
    await movementModel.updateOne(
      { idempotencyKey },
      {
        $setOnInsert: {
          productKey: item.productKey,
          movementType: "RETURN",
          quantity: item.quantity,
          reason: movementReason,
          referenceId: normalizedOrderId,
          unitPrice: item.unitPrice,
          amount: item.unitPrice * item.quantity,
          idempotencyKey,
          happenedAt: new Date(),
          createdBy: actorPayload,
          metadata: {
            operation: "order_return",
          },
        },
      },
      { upsert: true }
    );
  }

  order.status = "Refunded";
  order.returnProcessedAt = new Date();
  await order.save();

  return {
    orderId: normalizedOrderId,
    createdMovements: orderItems.length,
    duplicateMovements: 0,
    idempotent: false,
  };
};

const normalizeProductFilter = (value) => {
  if (!value || String(value).toUpperCase() === "ALL") return null;
  return normalizeProductKeyValue(value);
};

export const getInventoryRows = async (
  { productKey } = {},
  { productModel = InventoryProduct } = {}
) => {
  const normalizedProduct = normalizeProductFilter(productKey);
  if (productKey && !normalizedProduct && String(productKey).toUpperCase() !== "ALL") {
    throw new InventoryError("Invalid product filter", 400);
  }

  const products = await listSnapshotProducts(
    { productKey: normalizedProduct },
    { productModel }
  );
  return products.map(mapInventoryRow);
};

const summarizePeriod = (movements, start, end) => {
  let unitsSold = 0;
  let revenue = 0;
  for (const movement of movements) {
    const happenedAt = toDate(movement.happenedAt, null);
    if (!happenedAt) continue;
    if (happenedAt < start || happenedAt > end) continue;

    if (movement.movementType === "OUT") {
      unitsSold += Math.abs(toNumber(movement.quantity, 0));
    }
    revenue += calculateRevenueDelta(movement);
  }
  return { unitsSold, revenue };
};

const buildWeeklyTrend = (movements, start, end) => {
  const from = startOfWeek(start);
  const to = startOfWeek(end);
  const buckets = new Map();

  for (let cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 7)) {
    const key = cursor.toISOString().slice(0, 10);
    buckets.set(key, {
      weekStart: key,
      label: cursor.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      unitsSold: 0,
      revenue: 0,
    });
  }

  for (const movement of movements) {
    const happenedAt = toDate(movement.happenedAt, null);
    if (!happenedAt) continue;
    if (happenedAt < start || happenedAt > end) continue;

    const bucketStart = startOfWeek(happenedAt).toISOString().slice(0, 10);
    const bucket = buckets.get(bucketStart);
    if (!bucket) continue;

    if (movement.movementType === "OUT") {
      bucket.unitsSold += Math.abs(toNumber(movement.quantity, 0));
    }
    bucket.revenue += calculateRevenueDelta(movement);
  }

  return Array.from(buckets.values());
};

export const getDashboardMetrics = async (
  { from, to, productKey } = {},
  {
    productModel = InventoryProduct,
    movementModel = InventoryMovement,
    orderModel = InventoryOrder,
  } = {}
) => {
  const dateRange = normalizeDateRange({ from, to, defaultDays: 30 });
  const normalizedProduct = normalizeProductFilter(productKey);
  if (productKey && !normalizedProduct && String(productKey).toUpperCase() !== "ALL") {
    throw new InventoryError("Invalid product filter", 400);
  }

  const inventoryRows = await getInventoryRows(
    { productKey: normalizedProduct || "ALL" },
    { productModel }
  );

  const now = new Date();
  const todayStart = startOfDay(now);
  const sevenDaysStart = startOfDay(
    new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
  );
  const thirtyDaysStart = startOfDay(
    new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)
  );

  const earliestMovementDate =
    dateRange.start < thirtyDaysStart ? dateRange.start : thirtyDaysStart;
  const movementFilter = {
    movementType: { $in: ["OUT", "RETURN"] },
    happenedAt: { $gte: earliestMovementDate, $lte: dateRange.end },
  };
  if (normalizedProduct) movementFilter.productKey = normalizedProduct;

  const salesMovements = await movementModel
    .find(movementFilter, "productKey movementType quantity amount unitPrice happenedAt")
    .lean();

  const todaySummary = summarizePeriod(salesMovements, todayStart, dateRange.end);
  const days7Summary = summarizePeriod(salesMovements, sevenDaysStart, dateRange.end);
  const days30Summary = summarizePeriod(
    salesMovements,
    thirtyDaysStart,
    dateRange.end
  );
  const rangeSummary = summarizePeriod(
    salesMovements,
    dateRange.start,
    dateRange.end
  );

  const orderStatuses = await orderModel.find({}, "status orderStatus").lean();
  const pendingOrders = orderStatuses.filter((order) =>
    isPendingOrderStatus(order.status, order.orderStatus)
  ).length;

  const totalAvailable = inventoryRows.reduce(
    (sum, row) => sum + toNumber(row.availableStock, 0),
    0
  );
  const averageDailySales7 = days7Summary.unitsSold / 7;
  const daysOfStockLeft =
    averageDailySales7 > 0
      ? Number((totalAvailable / averageDailySales7).toFixed(2))
      : null;

  const lowStockAlerts = inventoryRows.filter((row) => row.status !== "In Stock");
  const trend = buildWeeklyTrend(salesMovements, dateRange.start, dateRange.end);

  const productSummary = inventoryRows.map((row) => ({
    productKey: row.productKey,
    name: row.product,
    currentStock: row.currentStock,
    availableStock: row.availableStock,
    reorderLevel: row.reorderLevel,
    status: row.status,
    inventoryStatus: row.inventoryStatus,
    lowStock: row.lowStock,
  }));

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      productKey: normalizedProduct || "ALL",
      from: dateRange.start.toISOString(),
      to: dateRange.end.toISOString(),
    },
    cards: {
      currentStock: productSummary,
      unitsSold: {
        today: todaySummary.unitsSold,
        days7: days7Summary.unitsSold,
        days30: days30Summary.unitsSold,
        selectedRange: rangeSummary.unitsSold,
      },
      revenue: {
        today: todaySummary.revenue,
        days7: days7Summary.revenue,
        days30: days30Summary.revenue,
        selectedRange: rangeSummary.revenue,
      },
      lowStockAlerts,
      pendingOrders,
    },
    inventoryRows,
    insights: {
      averageDailySales7,
      daysOfStockLeft,
      salesTrend: trend,
      productsTracked: inventoryRows.length,
    },
  };
};

export const getLedgerEntries = async (
  { from, to, productKey, movementType, page = 1, limit = 20 } = {},
  {
    productModel = InventoryProduct,
    movementModel = InventoryMovement,
  } = {}
) => {
  const dateRange = normalizeDateRange({ from, to, defaultDays: 30 });
  const normalizedProduct = normalizeProductFilter(productKey);
  if (productKey && !normalizedProduct && String(productKey).toUpperCase() !== "ALL") {
    throw new InventoryError("Invalid product filter", 400);
  }

  const normalizedMovementType = String(movementType || "ALL").toUpperCase();
  if (normalizedMovementType !== "ALL" && !MOVEMENT_TYPES.has(normalizedMovementType)) {
    throw new InventoryError("Invalid movement type filter", 400);
  }

  const safePage = Math.max(1, Math.floor(toNumber(page, 1)));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(toNumber(limit, 20))));

  const filter = {
    happenedAt: { $gte: dateRange.start, $lte: dateRange.end },
  };
  if (normalizedProduct) filter.productKey = normalizedProduct;
  if (normalizedMovementType !== "ALL") filter.movementType = normalizedMovementType;

  const [products, totalItems, entries] = await Promise.all([
    ensureInventoryProducts(productModel),
    movementModel.countDocuments(filter),
    movementModel
      .find(filter)
      .sort({ happenedAt: -1, createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
  ]);

  const productMap = new Map(
    products.map((product) => [product.productKey, product.productName || product.name])
  );

  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    product: productMap.get(entry.productKey) || entry.productKey,
    signedQuantity: calculateSignedStockDelta(
      entry.movementType,
      entry.quantity,
      entry.adjustmentSign
    ),
  }));

  const totalPages = Math.max(1, Math.ceil(totalItems / safeLimit));
  return {
    items: normalizedEntries,
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalItems,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    },
  };
};

export const listInventoryOrders = async (
  { limit = 100 } = {},
  { orderModel = InventoryOrder } = {}
) => {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(toNumber(limit, 100))));
  const orders = await orderModel
    .find({})
    .sort({ orderDate: -1, createdAt: -1 })
    .limit(safeLimit)
    .lean();

  return orders.map(mapOrderRecord);
};

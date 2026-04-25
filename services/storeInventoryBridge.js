import mongoose from "mongoose";

import { InventoryProduct } from "../models/InventoryProduct.js";
import { Product } from "../models/Product.js";

const asText = (value) => (value == null ? "" : String(value).trim());

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toInteger = (value, fallback = 0) =>
  Math.max(0, Math.floor(toNumber(value, fallback)));

const toInventoryStatus = (available) =>
  toInteger(available, 0) > 0 ? "IN_STOCK" : "OUT_OF_STOCK";

const logInventoryDebug = (label, inventoryLike = {}, productId = "") => {
  const totalStock = Math.max(0, toInteger(inventoryLike?.totalStock, 0));
  const reserved = Math.min(
    totalStock,
    Math.max(0, toInteger(inventoryLike?.reserved ?? inventoryLike?.reservedStock, 0))
  );
  const available = Math.max(0, totalStock - reserved);
  const ref = asText(productId || inventoryLike?.productId || inventoryLike?.productKey);

  console.info(
    `[Inventory Debug] ${label} :: product=${ref} total_stock=${totalStock} reserved_stock=${reserved} available_stock=${available}`
  );

  if (totalStock > 0 && reserved === 0 && available === 0) {
    console.warn(
      `[Inventory Debug] ${label} unexpected zero available stock for positive total stock (product=${ref})`
    );
  }
};

const normalizeInventoryState = (inventory) => {
  const totalSeed = Math.max(
    0,
    toInteger(inventory?.totalStock, 0)
  );
  const reservedSeed = Math.max(
    0,
    toInteger(inventory?.reservedStock ?? inventory?.reserved, 0)
  );
  const availableSeed = Math.max(
    0,
    toInteger(inventory?.availableStock ?? inventory?.available, 0)
  );

  const adjustedTotal = Math.max(totalSeed, reservedSeed + availableSeed);
  const adjustedReserved = Math.min(reservedSeed, adjustedTotal);
  const adjustedAvailable = Math.max(0, adjustedTotal - adjustedReserved);

  return {
    totalStock: adjustedTotal,
    reserved: adjustedReserved,
    available: adjustedAvailable,
  };
};

const assignInventoryState = (inventory, nextState) => {
  const totalStock = Math.max(0, toInteger(nextState?.totalStock, 0));
  const reserved = Math.max(0, Math.min(toInteger(nextState?.reserved, 0), totalStock));
  const available = Math.max(0, totalStock - reserved);

  inventory.totalStock = totalStock;
  inventory.reserved = reserved;
  inventory.available = available;
  inventory.reservedStock = reserved;
  inventory.availableStock = available;
  inventory.status = toInventoryStatus(available);
};

const groupOrderItemsByProduct = (items = []) => {
  const grouped = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const productId = asText(item?.productId || item?.id || item?._id);
    if (!productId) continue;

    const quantity = Math.max(1, toInteger(item?.quantity ?? item?.qty, 1));
    grouped.set(productId, (grouped.get(productId) || 0) + quantity);
  }

  return grouped;
};

export class StoreInventoryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "StoreInventoryError";
    this.statusCode = statusCode;
  }
}

export const normalizeStoreOrderStatus = (value, fallback = "") => {
  const normalized = asText(value).toUpperCase();
  if (!normalized) return fallback ? normalizeStoreOrderStatus(fallback, "") : "";

  if (normalized === "PLACED" || normalized === "PENDING" || normalized === "CONFIRMED") {
    return "PLACED";
  }
  if (normalized === "PROCESSING") return "PROCESSING";
  if (normalized === "SHIPPED") return "SHIPPED";
  if (normalized === "DELIVERED") return "DELIVERED";
  if (normalized === "CANCELLED" || normalized === "CANCELED") return "CANCELLED";
  return "";
};

const findInventoryByProductId = async (productId) => {
  const normalizedProductId = asText(productId);
  if (!normalizedProductId) return null;
  return InventoryProduct.findOne({ productId: normalizedProductId });
};

export const ensureInventoryForProduct = async (product) => {
  const productId = asText(product?._id);
  if (!productId) return null;

  const productName = asText(product?.name) || "Product";
  const initialStock = Math.max(
    0,
    toInteger(product?.inventory?.stock ?? product?.stock, 0)
  );
  const sku = asText(product?.sku) || productId;
  const unitPrice = Math.max(
    0,
    toNumber(product?.sellingPrice ?? product?.price, 0)
  );

  await InventoryProduct.updateOne(
    { productId },
    {
      $setOnInsert: {
        productKey: productId,
        productName,
        name: productName,
        sku,
        productId,
        unitPrice,
        totalStock: initialStock,
        reserved: 0,
        reservedStock: 0,
        available: initialStock,
        availableStock: initialStock,
        reorderLevel: 10,
        isActive: true,
        status: toInventoryStatus(initialStock),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return findInventoryByProductId(productId);
};

export const ensureInventoryForProducts = async (products = []) => {
  const list = (Array.isArray(products) ? products : []).filter(
    (product) => asText(product?._id)
  );
  if (!list.length) return [];

  const productIds = list.map((product) => asText(product?._id));
  const existing = await InventoryProduct.find({
    productId: { $in: productIds },
  })
    .select("productId")
    .lean();

  const existingIds = new Set(existing.map((item) => asText(item?.productId)));
  const missingProducts = list.filter(
    (product) => !existingIds.has(asText(product?._id))
  );

  if (!missingProducts.length) return list;

  await Promise.all(
    missingProducts.map((product) => ensureInventoryForProduct(product))
  );
  return list;
};

export const removeInventoryForProduct = async (productId) => {
  const normalizedProductId = asText(productId);
  if (!normalizedProductId) return { acknowledged: true, deletedCount: 0 };

  return InventoryProduct.deleteMany({
    $or: [
      { productId: normalizedProductId },
      { productKey: normalizedProductId },
    ],
  });
};

export const restoreInventorySnapshots = async (snapshots = []) => {
  for (const snapshot of [...(Array.isArray(snapshots) ? snapshots : [])].reverse()) {
    const inventoryId = asText(snapshot?.inventoryId);
    if (!inventoryId || !mongoose.Types.ObjectId.isValid(inventoryId)) continue;

    const inventory = await InventoryProduct.findById(inventoryId);
    if (!inventory) continue;

    assignInventoryState(inventory, snapshot?.state || {});
    await inventory.save();
  }
};

export const reserveInventoryForOrderItems = async (items = []) => {
  const groupedItems = groupOrderItemsByProduct(items);
  const snapshots = [];

  try {
    for (const [productId, quantity] of groupedItems.entries()) {
      let inventory = await findInventoryByProductId(productId);
      if (!inventory && mongoose.Types.ObjectId.isValid(productId)) {
        const product = await Product.findById(productId)
          .select("name sku sellingPrice price inventory stock")
          .lean();
        if (product) {
          await ensureInventoryForProduct(product);
          inventory = await findInventoryByProductId(productId);
        }
      }

      if (!inventory) {
        throw new StoreInventoryError("Out of stock", 409);
      }

      const previous = normalizeInventoryState(inventory);
      if (previous.available < quantity) {
        throw new StoreInventoryError("Out of stock", 409);
      }

      assignInventoryState(inventory, {
        totalStock: previous.totalStock,
        reserved: previous.reserved + quantity,
        available: previous.available - quantity,
      });

      await inventory.save();
      logInventoryDebug("reserve_order_items", inventory, productId);
      snapshots.push({
        inventoryId: inventory._id?.toString(),
        state: previous,
      });
    }

    return snapshots;
  } catch (error) {
    await restoreInventorySnapshots(snapshots);
    throw error;
  }
};

export const applyInventoryForStoreOrderStatus = async ({ order, nextStatus }) => {
  const normalizedNext = normalizeStoreOrderStatus(nextStatus);
  if (!normalizedNext) {
    throw new StoreInventoryError("status is required", 400);
  }

  const normalizedPrevious = normalizeStoreOrderStatus(order?.status, "PLACED");
  if (normalizedPrevious === normalizedNext) {
    return { idempotent: true, inventoryUpdated: false };
  }

  if (normalizedNext !== "DELIVERED" && normalizedNext !== "CANCELLED") {
    return { idempotent: false, inventoryUpdated: false };
  }

  const groupedItems = groupOrderItemsByProduct(order?.items || []);
  if (groupedItems.size === 0) {
    return { idempotent: false, inventoryUpdated: false };
  }

  const snapshots = [];

  try {
    for (const [productId, quantity] of groupedItems.entries()) {
      const inventory = await findInventoryByProductId(productId);
      if (!inventory) continue;

      const previous = normalizeInventoryState(inventory);
      snapshots.push({
        inventoryId: inventory._id?.toString(),
        state: previous,
      });

      if (normalizedNext === "DELIVERED") {
        const reserved = Math.max(0, previous.reserved - quantity);
        const totalStock = Math.max(0, previous.totalStock - quantity);
        const available = Math.max(
          0,
          Math.min(previous.available, totalStock - reserved)
        );

        assignInventoryState(inventory, { totalStock, reserved, available });
      } else {
        const reserved = Math.max(0, previous.reserved - quantity);
        const available = Math.max(
          0,
          Math.min(previous.totalStock, previous.available + quantity)
        );

        assignInventoryState(inventory, {
          totalStock: previous.totalStock,
          reserved,
          available,
        });
      }

      await inventory.save();
      logInventoryDebug(
        normalizedNext === "DELIVERED"
          ? "order_status_delivered"
          : "order_status_cancelled",
        inventory,
        productId
      );
    }

    return { idempotent: false, inventoryUpdated: true };
  } catch (error) {
    await restoreInventorySnapshots(snapshots);
    throw error;
  }
};

export const listInventoryRowsWithProductDetails = async ({ productKey } = {}) => {
  const normalizedFilter = asText(productKey);
  const showAll = !normalizedFilter || normalizedFilter.toUpperCase() === "ALL";

  let inventoryDocs = [];
  let productMap = new Map();

  if (showAll) {
    const products = await Product.find({})
      .select("name sku sellingPrice price inventory stock")
      .lean();

    await ensureInventoryForProducts(products);

    const productIds = products
      .map((product) => asText(product?._id))
      .filter(Boolean);

    if (!productIds.length) return [];

    inventoryDocs = await InventoryProduct.find({
      productId: { $in: productIds },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    productMap = new Map(
      products.map((product) => [asText(product?._id), product])
    );
  } else {
    const filter = mongoose.Types.ObjectId.isValid(normalizedFilter)
      ? { $or: [{ productKey: normalizedFilter }, { productId: normalizedFilter }] }
      : { productKey: normalizedFilter };

    inventoryDocs = await InventoryProduct.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (!inventoryDocs.length && mongoose.Types.ObjectId.isValid(normalizedFilter)) {
      const product = await Product.findById(normalizedFilter)
        .select("name sku sellingPrice price inventory stock")
        .lean();
      if (product) {
        await ensureInventoryForProduct(product);
        inventoryDocs = await InventoryProduct.find(filter)
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean();
      }
    }

    const linkedProductIds = [
      ...new Set(
        inventoryDocs
          .map((entry) => asText(entry?.productId))
          .filter((entry) => mongoose.Types.ObjectId.isValid(entry))
      ),
    ];

    const linkedProducts = linkedProductIds.length
      ? await Product.find({ _id: { $in: linkedProductIds } })
          .select("name sku sellingPrice price inventory stock")
          .lean()
      : [];

    productMap = new Map(
      linkedProducts.map((product) => [asText(product?._id), product])
    );
  }

  return inventoryDocs
    .map((inventory) => {
    const externalProductId = asText(inventory?.productId);
    const linkedProduct = productMap.get(externalProductId);
    if (!linkedProduct) return null;

    const normalizedState = normalizeInventoryState(inventory);
    const reorderLevel = Math.max(0, toInteger(inventory?.reorderLevel, 0));
    const status =
      normalizedState.available <= 0
        ? "Out"
        : normalizedState.available < reorderLevel
          ? "Low"
          : "In Stock";
    const resolvedProductName =
      asText(linkedProduct?.name) ||
      asText(inventory?.productName || inventory?.name) ||
      "Product";
    const resolvedSku = asText(linkedProduct?.sku) || asText(inventory?.sku);
    const resolvedUnitPrice = Math.max(
      0,
      toNumber(
        inventory?.unitPrice,
        toNumber(linkedProduct?.sellingPrice ?? linkedProduct?.price, 0)
      )
    );
    const resolvedProductKey =
      asText(inventory?.productKey) ||
      externalProductId ||
      asText(inventory?._id);

    return {
      productKey: resolvedProductKey,
      productId: inventory?._id,
      externalProductId,
      product_id: externalProductId,
      inventory_id: inventory?._id,
      product: resolvedProductName,
      productName: resolvedProductName,
      sku: resolvedSku,
      unitPrice: resolvedUnitPrice,
      unit_price: resolvedUnitPrice,
      currentStock: normalizedState.totalStock,
      totalStock: normalizedState.totalStock,
      total_stock: normalizedState.totalStock,
      reservedStock: normalizedState.reserved,
      reserved_stock: normalizedState.reserved,
      availableStock: normalizedState.available,
      available_stock: normalizedState.available,
      reorderLevel,
      reorder_level: reorderLevel,
      lastRestocked: inventory?.lastRestocked || inventory?.lastRestockedAt || null,
      last_restocked: inventory?.lastRestocked || inventory?.lastRestockedAt || null,
      inventoryStatus: toInventoryStatus(normalizedState.available),
      statusCode: toInventoryStatus(normalizedState.available),
      status_code: toInventoryStatus(normalizedState.available),
      lowStock: normalizedState.available < reorderLevel,
      low_stock: normalizedState.available < reorderLevel,
      status,
    };
    })
    .filter(Boolean);
};

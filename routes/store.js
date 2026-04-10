import express from "express";
import mongoose from "mongoose";

import { auth, optionalAuth } from "../middleware/auth.js";
import { BUCKET_NAME } from "../config/s3.js";
import { Product } from "../models/Product.js";
import { StoreCart } from "../models/StoreCart.js";
import { StoreOrder } from "../models/StoreOrder.js";
import { generateSignedUrl } from "../utils/s3Utils.js";

const router = express.Router();

const hasAWSCredentials =
  !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asText = (value) => (value == null ? "" : String(value).trim());

const toAbsoluteUploadsUrl = (value) => {
  const raw = asText(value);
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;

  const baseUrl = asText(
    process.env.PUBLIC_SERVER_BASE_URL || process.env.API_BASE_URL
  ).replace(/\/api\/?$/i, "");
  const resolvedBase = baseUrl || `http://localhost:${process.env.PORT || 5000}`;

  if (raw.startsWith("/uploads/")) return `${resolvedBase}${raw}`;
  if (raw.startsWith("uploads/")) return `${resolvedBase}/${raw}`;
  return "";
};

const normalizeRole = (value) => {
  const role = asText(value).toLowerCase();
  if (["patient", "doctor", "admin"].includes(role)) return role;
  return "";
};

const parsePositiveInt = (value, fallback, { min = 1, max = 100 } = {}) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const resolveProductImage = async (product) => {
  const media = product?.media || {};
  const fromMedia =
    asText(media.thumbnail) ||
    (Array.isArray(media.images) ? asText(media.images[0]) : "") ||
    asText(product?.imageUrl);
  const direct = toAbsoluteUploadsUrl(fromMedia);
  if (direct) return direct;

  const imageKey = asText(product?.imageKey);
  if (imageKey) {
    const directKey = toAbsoluteUploadsUrl(imageKey);
    if (directKey) return directKey;
    if (hasAWSCredentials) {
      try {
        return await generateSignedUrl(imageKey, BUCKET_NAME);
      } catch {
        // Fall through to raw image URL.
      }
    }
  }

  return /^https?:\/\//i.test(fromMedia) ? fromMedia : "";
};

const mapProductForClient = async (product) => {
  const unitPrice = toNumber(product?.sellingPrice ?? product?.price, 0);
  const mrp = toNumber(product?.mrp, unitPrice);
  const rating = toNumber(product?.rating ?? product?.avgRating, 0);

  return {
    id: product?._id?.toString(),
    name: asText(product?.name),
    shortDescription: asText(
      product?.shortDescription || product?.description || ""
    ),
    category: asText(product?.category),
    subCategory: asText(product?.subCategory),
    rating,
    mrp,
    sellingPrice: unitPrice,
    inventory: {
      stock: Math.max(0, toNumber(product?.inventory?.stock, 0)),
      availability: asText(product?.inventory?.availability || "IN_STOCK")
        .toUpperCase(),
    },
    imageUrl: await resolveProductImage(product),
    updatedAt: product?.updatedAt,
  };
};

const getPrincipalContext = (req) => {
  const principalId = asText(req.auth?.id);
  const role = normalizeRole(req.auth?.role);
  if (!principalId || !role) {
    return null;
  }
  return { principalId, role };
};

const isOrderableProduct = (product) => {
  if (!product || product.isActive === false) return false;
  const availability = asText(product.inventory?.availability).toUpperCase();
  const stock = toNumber(product.inventory?.stock, 0);
  if (availability === "OUT_OF_STOCK") return false;
  if (stock <= 0 && availability !== "PREORDER") return false;
  return true;
};

const buildCartItemSnapshot = async ({ product, quantity }) => {
  const imageUrl = await resolveProductImage(product);
  const unitPrice = Math.max(0, toNumber(product?.sellingPrice ?? product?.price, 0));

  return {
    productId: product._id,
    quantity,
    priceSnapshot: {
      name: asText(product.name),
      category: asText(product.category),
      imageUrl,
      unitPrice,
    },
  };
};

const recalculateCartTotals = (cart) => {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const itemCount = items.reduce((sum, item) => sum + Math.max(0, toNumber(item?.quantity, 0)), 0);
  const subtotal = items.reduce((sum, item) => {
    const qty = Math.max(0, toNumber(item?.quantity, 0));
    const unitPrice = Math.max(0, toNumber(item?.priceSnapshot?.unitPrice, 0));
    return sum + qty * unitPrice;
  }, 0);

  cart.totals = {
    itemCount,
    subtotal: Number(subtotal.toFixed(2)),
  };
};

const mapCartForClient = async (cart, productsById = new Map()) => {
  const items = Array.isArray(cart?.items) ? cart.items : [];

  const mappedItems = await Promise.all(
    items.map(async (item) => {
      const productId = item?.productId?.toString?.() || asText(item?.productId);
      const product = productsById.get(productId);

      const snapshotImage = asText(item?.priceSnapshot?.imageUrl);
      const imageUrl = product
        ? await resolveProductImage(product)
        : toAbsoluteUploadsUrl(snapshotImage) || snapshotImage;

      return {
        itemId: item?._id?.toString?.() || "",
        productId,
        quantity: Math.max(1, toNumber(item?.quantity, 1)),
        name: asText(item?.priceSnapshot?.name),
        category: asText(item?.priceSnapshot?.category),
        imageUrl,
        unitPrice: Math.max(0, toNumber(item?.priceSnapshot?.unitPrice, 0)),
        lineTotal: Number(
          (
            Math.max(1, toNumber(item?.quantity, 1)) *
            Math.max(0, toNumber(item?.priceSnapshot?.unitPrice, 0))
          ).toFixed(2)
        ),
        productStatus: product
          ? {
              isActive: product.isActive !== false,
              availability: asText(product?.inventory?.availability || "").toUpperCase(),
              stock: Math.max(0, toNumber(product?.inventory?.stock, 0)),
            }
          : null,
      };
    })
  );

  return {
    items: mappedItems,
    totals: {
      itemCount: Math.max(0, toNumber(cart?.totals?.itemCount, 0)),
      subtotal: Number(Math.max(0, toNumber(cart?.totals?.subtotal, 0)).toFixed(2)),
    },
    updatedAt: cart?.updatedAt,
  };
};

const ensureCart = async ({ principalId, role }) => {
  let cart = await StoreCart.findOne({ principalId, role });
  if (!cart) {
    cart = await StoreCart.create({ principalId, role, items: [], totals: { itemCount: 0, subtotal: 0 } });
  }
  return cart;
};

const buildDeliveryPayload = (input = {}) => {
  const payload = {
    fullName: asText(input.fullName),
    phone: asText(input.phone),
    addressLine1: asText(input.addressLine1),
    addressLine2: asText(input.addressLine2),
    city: asText(input.city),
    state: asText(input.state),
    pincode: asText(input.pincode),
    notes: asText(input.notes),
  };

  const missing = [
    ["fullName", payload.fullName],
    ["phone", payload.phone],
    ["addressLine1", payload.addressLine1],
    ["city", payload.city],
    ["state", payload.state],
    ["pincode", payload.pincode],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field);

  return { payload, missing };
};

// Public/discoverable product listing with filter/search.
router.get("/products", optionalAuth, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 60 });
    const search = asText(req.query.search);
    const category = asText(req.query.category);
    const minRating = toNumber(req.query.minRating, 0);
    const minPrice = toNumber(req.query.minPrice, 0);
    const maxPrice = toNumber(req.query.maxPrice, 0);
    const sort = asText(req.query.sort).toLowerCase();

    const query = { isActive: true };
    if (category) {
      query.category = category;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { shortDescription: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    if (minPrice > 0 || maxPrice > 0) {
      query.sellingPrice = {};
      if (minPrice > 0) {
        query.sellingPrice.$gte = minPrice;
      }
      if (maxPrice > 0 && maxPrice >= minPrice) {
        query.sellingPrice.$lte = maxPrice;
      }
    }

    if (minRating > 0) {
      query.$and = [...(query.$and || []), { rating: { $gte: minRating } }];
    }

    const sortSpec =
      sort === "price_asc"
        ? { sellingPrice: 1, updatedAt: -1 }
        : sort === "price_desc"
          ? { sellingPrice: -1, updatedAt: -1 }
          : sort === "rating_desc"
            ? { rating: -1, updatedAt: -1 }
            : { updatedAt: -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select(
          "name shortDescription description category subCategory mrp sellingPrice price inventory imageUrl imageKey media rating avgRating updatedAt createdAt isActive"
        )
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const mappedProducts = await Promise.all(
      products.map((product) => mapProductForClient(product))
    );

    return res.json({
      success: true,
      products: mappedProducts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
});

router.get("/cart", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const cart = await StoreCart.findOne(principal);
    if (!cart) {
      return res.json({
        success: true,
        cart: {
          items: [],
          totals: { itemCount: 0, subtotal: 0 },
        },
      });
    }

    const productIds = (cart.items || [])
      .map((item) => item?.productId)
      .filter((value) => mongoose.Types.ObjectId.isValid(value));

    const products = await Product.find({ _id: { $in: productIds } })
      .select("name category imageUrl imageKey media inventory isActive sellingPrice price")
      .lean();

    const productsById = new Map(
      products.map((product) => [product._id.toString(), product])
    );

    return res.json({
      success: true,
      cart: await mapCartForClient(cart, productsById),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cart",
      error: error.message,
    });
  }
});

router.post("/cart/items", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const productId = asText(req.body.productId);
    const quantity = parsePositiveInt(req.body.quantity, 1, {
      min: 1,
      max: 20,
    });

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ success: false, message: "Invalid productId" });
    }

    const product = await Product.findById(productId).lean();
    if (!product || product.isActive === false) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (!isOrderableProduct(product)) {
      return res.status(400).json({
        success: false,
        message: "Product is currently unavailable",
      });
    }

    const cart = await ensureCart(principal);
    const existingItem = cart.items.find(
      (item) => item?.productId?.toString?.() === productId
    );

    if (existingItem) {
      existingItem.quantity = Math.min(20, existingItem.quantity + quantity);
      const snapshot = await buildCartItemSnapshot({
        product,
        quantity: existingItem.quantity,
      });
      existingItem.priceSnapshot = snapshot.priceSnapshot;
    } else {
      const snapshot = await buildCartItemSnapshot({ product, quantity });
      cart.items.push(snapshot);
    }

    recalculateCartTotals(cart);
    await cart.save();

    return res.status(201).json({
      success: true,
      message: "Added to cart",
      cart: await mapCartForClient(cart),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update cart",
      error: error.message,
    });
  }
});

router.patch("/cart/items/:itemId", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const itemId = asText(req.params.itemId);
    const quantity = parsePositiveInt(req.body.quantity, 1, {
      min: 0,
      max: 20,
    });

    const cart = await ensureCart(principal);
    const itemIndex = cart.items.findIndex(
      (item) => item?._id?.toString?.() === itemId
    );

    if (itemIndex < 0) {
      return res.status(404).json({ success: false, message: "Cart item not found" });
    }

    if (quantity <= 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      const existing = cart.items[itemIndex];
      existing.quantity = quantity;
      const product = await Product.findById(existing.productId)
        .select("name category imageUrl imageKey media sellingPrice price")
        .lean();
      if (product) {
        const snapshot = await buildCartItemSnapshot({
          product,
          quantity,
        });
        existing.priceSnapshot = snapshot.priceSnapshot;
      }
    }

    recalculateCartTotals(cart);
    await cart.save();

    return res.json({
      success: true,
      message: "Cart updated",
      cart: await mapCartForClient(cart),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update cart",
      error: error.message,
    });
  }
});

router.delete("/cart/items/:itemId", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const itemId = asText(req.params.itemId);
    const cart = await ensureCart(principal);
    const beforeCount = cart.items.length;
    cart.items = cart.items.filter((item) => item?._id?.toString?.() !== itemId);

    if (cart.items.length === beforeCount) {
      return res.status(404).json({ success: false, message: "Cart item not found" });
    }

    recalculateCartTotals(cart);
    await cart.save();

    return res.json({
      success: true,
      message: "Item removed",
      cart: await mapCartForClient(cart),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update cart",
      error: error.message,
    });
  }
});

router.post("/orders", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const cart = await StoreCart.findOne(principal);
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    const { payload: delivery, missing } = buildDeliveryPayload(req.body.delivery || req.body);
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing delivery fields: ${missing.join(", ")}`,
      });
    }

    const productIds = cart.items
      .map((item) => item?.productId)
      .filter((value) => mongoose.Types.ObjectId.isValid(value));

    const products = await Product.find({ _id: { $in: productIds }, isActive: true })
      .select("name category imageUrl imageKey media sellingPrice price inventory")
      .lean();

    const productsById = new Map(products.map((product) => [product._id.toString(), product]));

    const orderItems = [];
    for (const item of cart.items) {
      const productId = item?.productId?.toString?.() || "";
      const product = productsById.get(productId);

      if (!product || !isOrderableProduct(product)) {
        return res.status(400).json({
          success: false,
          message: `Product unavailable for checkout: ${item?.priceSnapshot?.name || "Unknown product"}`,
        });
      }

      const quantity = Math.max(1, toNumber(item?.quantity, 1));
      const unitPrice = Math.max(0, toNumber(product.sellingPrice ?? product.price, 0));
      const lineTotal = Number((quantity * unitPrice).toFixed(2));

      orderItems.push({
        productId: product._id,
        name: asText(product.name),
        category: asText(product.category),
        imageUrl: await resolveProductImage(product),
        quantity,
        unitPrice,
        lineTotal,
      });
    }

    const itemCount = orderItems.reduce(
      (sum, item) => sum + Math.max(1, toNumber(item.quantity, 1)),
      0
    );
    const subtotal = Number(
      orderItems
        .reduce((sum, item) => sum + Math.max(0, toNumber(item.lineTotal, 0)), 0)
        .toFixed(2)
    );

    const order = await StoreOrder.create({
      principalId: principal.principalId,
      role: principal.role,
      items: orderItems,
      delivery,
      totals: {
        itemCount,
        subtotal,
      },
      status: "PLACED",
    });

    cart.items = [];
    recalculateCartTotals(cart);
    await cart.save();

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to place order",
      error: error.message,
    });
  }
});

router.get("/orders", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 60 });

    const query = {
      principalId: principal.principalId,
      role: principal.role,
    };

    const [orders, total] = await Promise.all([
      StoreOrder.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StoreOrder.countDocuments(query),
    ]);

    return res.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
});

router.get("/orders/:id", auth, async (req, res) => {
  try {
    const principal = getPrincipalContext(req);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const orderId = asText(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await StoreOrder.findOne({
      _id: orderId,
      principalId: principal.principalId,
      role: principal.role,
    }).lean();

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    return res.json({ success: true, order });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch order",
      error: error.message,
    });
  }
});

export default router;

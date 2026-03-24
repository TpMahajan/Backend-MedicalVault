import express from "express";
import { requireAdminAuth, requireAdminPermissions } from "../middleware/adminAuth.js";
import { AuditLog } from "../models/AuditLog.js";
import { SecurityAlert } from "../models/SecurityAlert.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import { recordSecurityEvent } from "../services/securityEventService.js";
import { SecurityEvent } from "../models/SecurityEvent.js";

const router = express.Router();

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

router.get(
  "/audit-logs",
  requireAdminAuth,
  requireAdminPermissions("VIEW_AUDIT_LOGS"),
  async (req, res) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = Math.min(parsePositiveInt(req.query.limit, 10), 100);
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.userId) filter.actorId = String(req.query.userId).trim();
      if (req.query.role) filter.actorRole = String(req.query.role).trim().toLowerCase();
      if (req.query.action) filter.action = String(req.query.action).trim();
      if (req.query.source) {
        const source = String(req.query.source).trim().toLowerCase();
        if (source === "app") {
          filter.userAgent = { $regex: "(dart|flutter|okhttp)", $options: "i" };
        } else if (source === "web") {
          filter.userAgent = { $not: /(dart|flutter|okhttp)/i };
        }
      }
      if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(String(req.query.from));
        if (req.query.to) filter.createdAt.$lte = new Date(String(req.query.to));
      }

      const [items, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        AuditLog.countDocuments(filter),
      ]);
      await writeAuditLog({
        req,
        action: "READ_AUDIT_LOGS",
        resourceType: "AUDIT_LOG",
        statusCode: 200,
        metadata: { page, limit, total },
      });
      if (limit >= 75 && !req.query.userId && !req.query.action) {
        await recordSecurityEvent({
          eventType: "DATA_ACCESS_ANOMALY",
          severity: "HIGH",
          actorId: req.auth?.id || "",
          actorRole: req.auth?.role || "",
          ipAddress: req.ip || "",
          userAgent: req.headers["user-agent"] || "",
          reason: "High-volume broad audit-log access pattern detected",
          breachFlag: false,
          metadata: { page, limit, total },
        });
      }

      return res.json({
        success: true,
        items: items.map((item) => ({
          ...item,
          source:
            /(dart|flutter|okhttp)/i.test(String(item.userAgent || "")) ? "APP" : "WEB",
        })),
        pagination: {
          page,
          limit,
          totalItems: total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch {
      return res.status(500).json({ success: false, message: "Failed to fetch audit logs" });
    }
  }
);

router.get(
  "/alerts",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SECURITY_ALERTS"),
  async (req, res) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = Math.min(parsePositiveInt(req.query.limit, 10), 100);
      const skip = (page - 1) * limit;
      const filter = {};
      if (req.query.type) filter.type = String(req.query.type).trim().toUpperCase();
      if (req.query.severity) filter.severity = String(req.query.severity).trim().toUpperCase();
      if (typeof req.query.resolved !== "undefined") {
        filter.resolved = String(req.query.resolved).toLowerCase() === "true";
      }
      const [items, total] = await Promise.all([
        SecurityAlert.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        SecurityAlert.countDocuments(filter),
      ]);
      await writeAuditLog({
        req,
        action: "READ_SECURITY_ALERTS",
        resourceType: "SECURITY_ALERT",
        statusCode: 200,
        metadata: { page, limit, total },
      });
      return res.json({
        success: true,
        items,
        pagination: {
          page,
          limit,
          totalItems: total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch {
      return res.status(500).json({ success: false, message: "Failed to fetch security alerts" });
    }
  }
);

router.get(
  "/security-events",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SECURITY_ALERTS"),
  async (req, res) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = Math.min(parsePositiveInt(req.query.limit, 10), 100);
      const skip = (page - 1) * limit;
      const filter = {};
      if (req.query.eventType) filter.eventType = String(req.query.eventType).trim().toUpperCase();
      if (typeof req.query.breachFlag !== "undefined") {
        filter.breachFlag = String(req.query.breachFlag).toLowerCase() === "true";
      }
      const [items, total] = await Promise.all([
        SecurityEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        SecurityEvent.countDocuments(filter),
      ]);
      return res.json({
        success: true,
        items,
        pagination: {
          page,
          limit,
          totalItems: total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch {
      return res.status(500).json({ success: false, message: "Failed to fetch security events" });
    }
  }
);

router.post(
  "/security-events/breach-flag",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SECURITY_ALERTS"),
  async (req, res) => {
    try {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) {
        return res.status(400).json({ success: false, message: "reason is required" });
      }
      const event = await recordSecurityEvent({
        eventType: "BREACH_FLAG",
        severity: "HIGH",
        actorId: req.auth?.id || "",
        actorRole: req.auth?.role || "",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        reason,
        breachFlag: true,
        metadata: req.body?.metadata || {},
      });
      await writeAuditLog({
        req,
        action: "RAISE_BREACH_FLAG",
        resourceType: "SECURITY_EVENT",
        resourceId: event?._id?.toString() || "",
        statusCode: 201,
      });
      return res.status(201).json({ success: true, event });
    } catch {
      return res.status(500).json({ success: false, message: "Failed to raise breach flag" });
    }
  }
);

router.get(
  "/security-summary",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SECURITY_ALERTS"),
  async (req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [activeSessions, totalAlerts, unresolvedAlerts, failedLogins24h, severityRows] =
        await Promise.all([
          RefreshToken.countDocuments({
            role: { $in: ["patient", "doctor"] },
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          }),
          SecurityAlert.countDocuments({}),
          SecurityAlert.countDocuments({ resolved: false }),
          SecurityAlert.countDocuments({
            type: "MULTIPLE_FAILED_LOGINS",
            createdAt: { $gte: since },
          }),
          SecurityAlert.aggregate([{ $group: { _id: "$severity", count: { $sum: 1 } } }]),
        ]);

      const severity = severityRows.reduce((acc, row) => {
        acc[String(row._id || "UNKNOWN")] = Number(row.count || 0);
        return acc;
      }, {});

      await writeAuditLog({
        req,
        action: "READ_SECURITY_SUMMARY",
        resourceType: "SECURITY_DASHBOARD",
        statusCode: 200,
      });

      return res.json({
        success: true,
        summary: {
          activeSessions,
          alerts: totalAlerts,
          unresolvedAlerts,
          failedLogins24h,
          severity,
        },
      });
    } catch {
      return res.status(500).json({ success: false, message: "Failed to fetch security summary" });
    }
  }
);

export default router;


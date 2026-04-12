import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { AppError, getBearerToken, readJsonBody, requestMeta, sendHtml, sendJson, sendText } from "./http.js";
import { loadOrCreateLicenseKeyStore } from "./license-keys.js";
import { createRuntimeStateStore } from "./runtime-state.js";
import { createServices } from "./services.js";
import { createTcpServer } from "./tcp-server.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const adminHtml = fs.readFileSync(path.join(currentDir, "web", "console.html"), "utf8");
const noticeCenterHtml = fs.readFileSync(path.join(currentDir, "web", "notice-center.html"), "utf8");
const resellerCenterHtml = fs.readFileSync(path.join(currentDir, "web", "reseller-ops.html"), "utf8");
const resellerFinanceHtml = fs.readFileSync(path.join(currentDir, "web", "reseller-finance.html"), "utf8");
const securityCenterHtml = fs.readFileSync(path.join(currentDir, "web", "security-center.html"), "utf8");

function matchPath(pathname, pattern) {
  const pathnameParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathnameParts.length !== patternParts.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathnameParts[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }

    if (expected !== actual) {
      return null;
    }
  }

  return params;
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  config.licenseKeys = loadOrCreateLicenseKeyStore(config);
  const db = createDatabase(config);
  const runtimeState = createRuntimeStateStore({ db, config });
  const services = createServices(db, config, runtimeState);
  const tcpServer = createTcpServer({ services, config });

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_URL", message: "URL is missing." } });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      sendJson(res, 204, { ok: true });
      return;
    }

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
        sendHtml(res, 200, adminHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/notices") {
        sendHtml(res, 200, noticeCenterHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/resellers") {
        sendHtml(res, 200, resellerCenterHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/resellers/finance") {
        sendHtml(res, 200, resellerFinanceHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/security") {
        sendHtml(res, 200, securityCenterHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, data: await services.health() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/system/token-key") {
        sendJson(res, 200, { ok: true, data: services.tokenKey() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/system/token-keys") {
        sendJson(res, 200, { ok: true, data: services.tokenKeys() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/login") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, { ok: true, data: services.adminLogin(body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/products") {
        sendJson(res, 200, { ok: true, data: services.listProducts(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/products") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: services.createProduct(getBearerToken(req), body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/policies") {
        sendJson(
          res,
          200,
          { ok: true, data: services.listPolicies(getBearerToken(req), url.searchParams.get("productCode")) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/policies") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: services.createPolicy(getBearerToken(req), body) });
        return;
      }

      const policyRuntimeRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/policies/:policyId/runtime-config")
        : null;
      if (policyRuntimeRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updatePolicyRuntimeConfig(
            getBearerToken(req),
            policyRuntimeRoute.policyId,
            body
          )
        });
        return;
      }

      const policyUnbindRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/policies/:policyId/unbind-config")
        : null;
      if (policyUnbindRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updatePolicyUnbindConfig(
            getBearerToken(req),
            policyUnbindRoute.policyId,
            body
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/cards/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: services.createCardBatch(getBearerToken(req), body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/cards") {
        sendJson(res, 200, {
          ok: true,
          data: services.listCards(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            policyId: url.searchParams.get("policyId"),
            batchCode: url.searchParams.get("batchCode"),
            usageStatus: url.searchParams.get("usageStatus"),
            status: url.searchParams.get("status"),
            resellerId: url.searchParams.get("resellerId"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/cards/export") {
        const csv = services.exportCardsCsv(getBearerToken(req), {
          productCode: url.searchParams.get("productCode"),
          policyId: url.searchParams.get("policyId"),
          batchCode: url.searchParams.get("batchCode"),
          usageStatus: url.searchParams.get("usageStatus"),
          status: url.searchParams.get("status"),
          resellerId: url.searchParams.get("resellerId"),
          search: url.searchParams.get("search")
        });
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="cards-${Date.now()}.csv"`
          }
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/resellers") {
        sendJson(res, 200, {
          ok: true,
          data: services.listResellers(getBearerToken(req), {
            status: url.searchParams.get("status"),
            parentResellerId: url.searchParams.get("parentResellerId"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/resellers") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createReseller(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-inventory") {
        sendJson(res, 200, {
          ok: true,
          data: services.listResellerInventory(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            productCode: url.searchParams.get("productCode"),
            cardStatus: url.searchParams.get("cardStatus"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-price-rules") {
        sendJson(res, 200, {
          ok: true,
          data: services.listResellerPriceRules(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-statements") {
        sendJson(res, 200, {
          ok: true,
          data: services.listResellerStatements(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            currency: url.searchParams.get("currency"),
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/reseller-price-rules") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createResellerPriceRule(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/reseller-statements") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createResellerStatement(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-report") {
        sendJson(res, 200, {
          ok: true,
          data: services.resellerReport(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            productCode: url.searchParams.get("productCode"),
            cardStatus: url.searchParams.get("cardStatus"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-inventory/export") {
        const csv = services.exportResellerInventoryCsv(getBearerToken(req), {
          resellerId: url.searchParams.get("resellerId"),
          productCode: url.searchParams.get("productCode"),
          cardStatus: url.searchParams.get("cardStatus"),
          search: url.searchParams.get("search")
        });
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="reseller-inventory-${Date.now()}.csv"`
          }
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-settlement-report") {
        sendJson(res, 200, {
          ok: true,
          data: services.resellerSettlementReport(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            currency: url.searchParams.get("currency"),
            productCode: url.searchParams.get("productCode"),
            cardStatus: url.searchParams.get("cardStatus"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/reseller-settlement/export") {
        const csv = services.exportResellerSettlementCsv(getBearerToken(req), {
          resellerId: url.searchParams.get("resellerId"),
          currency: url.searchParams.get("currency"),
          productCode: url.searchParams.get("productCode"),
          cardStatus: url.searchParams.get("cardStatus"),
          search: url.searchParams.get("search")
        });
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="reseller-settlement-${Date.now()}.csv"`
          }
        );
        return;
      }

      const resellerStatementItemsRoute = req.method === "GET"
        ? matchPath(url.pathname, "/api/admin/reseller-statements/:statementId/items")
        : null;
      if (resellerStatementItemsRoute) {
        sendJson(res, 200, {
          ok: true,
          data: services.listResellerStatementItems(
            getBearerToken(req),
            resellerStatementItemsRoute.statementId
          )
        });
        return;
      }

      const resellerStatementExportRoute = req.method === "GET"
        ? matchPath(url.pathname, "/api/admin/reseller-statements/:statementId/export")
        : null;
      if (resellerStatementExportRoute) {
        const csv = services.exportResellerStatementCsv(
          getBearerToken(req),
          resellerStatementExportRoute.statementId
        );
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="reseller-statement-${Date.now()}.csv"`
          }
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
        sendJson(res, 200, { ok: true, data: await services.dashboard(getBearerToken(req)) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/accounts") {
        sendJson(res, 200, {
          ok: true,
          data: services.listAccounts(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/entitlements") {
        sendJson(res, 200, {
          ok: true,
          data: services.listEntitlements(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            grantType: url.searchParams.get("grantType"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      const accountStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/accounts/:accountId/status")
        : null;
      if (accountStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateAccountStatus(
            getBearerToken(req),
            accountStatusRoute.accountId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/device-bindings") {
        sendJson(res, 200, {
          ok: true,
          data: services.listDeviceBindings(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/device-blocks") {
        sendJson(res, 200, {
          ok: true,
          data: services.listDeviceBlocks(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/client-versions") {
        sendJson(res, 200, {
          ok: true,
          data: services.listClientVersions(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            channel: url.searchParams.get("channel"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/notices") {
        sendJson(res, 200, {
          ok: true,
          data: services.listNotices(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            channel: url.searchParams.get("channel"),
            kind: url.searchParams.get("kind"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/network-rules") {
        sendJson(res, 200, {
          ok: true,
          data: services.listNetworkRules(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            actionScope: url.searchParams.get("actionScope"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/device-blocks") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.blockDevice(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/client-versions") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createClientVersion(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/notices") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createNotice(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/network-rules") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createNetworkRule(getBearerToken(req), body)
        });
        return;
      }

      const bindingReleaseRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/device-bindings/:bindingId/release")
        : null;
      if (bindingReleaseRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.releaseDeviceBinding(
            getBearerToken(req),
            bindingReleaseRoute.bindingId,
            body
          )
        });
        return;
      }

      const cardStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/cards/:cardId/status")
        : null;
      if (cardStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateCardStatus(
            getBearerToken(req),
            cardStatusRoute.cardId,
            body
          )
        });
        return;
      }

      const entitlementStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/entitlements/:entitlementId/status")
        : null;
      if (entitlementStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateEntitlementStatus(
            getBearerToken(req),
            entitlementStatusRoute.entitlementId,
            body
          )
        });
        return;
      }

      const entitlementExtendRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/entitlements/:entitlementId/extend")
        : null;
      if (entitlementExtendRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.extendEntitlement(
            getBearerToken(req),
            entitlementExtendRoute.entitlementId,
            body
          )
        });
        return;
      }

      const entitlementPointsRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/entitlements/:entitlementId/points")
        : null;
      if (entitlementPointsRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.adjustEntitlementPoints(
            getBearerToken(req),
            entitlementPointsRoute.entitlementId,
            body
          )
        });
        return;
      }

      const resellerStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/resellers/:resellerId/status")
        : null;
      if (resellerStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateResellerStatus(
            getBearerToken(req),
            resellerStatusRoute.resellerId,
            body
          )
        });
        return;
      }

      const resellerAllocationRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/resellers/:resellerId/allocate-cards")
        : null;
      if (resellerAllocationRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.allocateResellerInventory(
            getBearerToken(req),
            resellerAllocationRoute.resellerId,
            body
          )
        });
        return;
      }

      const resellerPriceRuleStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/reseller-price-rules/:ruleId/status")
        : null;
      if (resellerPriceRuleStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateResellerPriceRuleStatus(
            getBearerToken(req),
            resellerPriceRuleStatusRoute.ruleId,
            body
          )
        });
        return;
      }

      const resellerStatementStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/reseller-statements/:statementId/status")
        : null;
      if (resellerStatementStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateResellerStatementStatus(
            getBearerToken(req),
            resellerStatementStatusRoute.statementId,
            body
          )
        });
        return;
      }

      const deviceUnblockRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/device-blocks/:blockId/unblock")
        : null;
      if (deviceUnblockRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.unblockDevice(
            getBearerToken(req),
            deviceUnblockRoute.blockId,
            body
          )
        });
        return;
      }

      const clientVersionStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/client-versions/:versionId/status")
        : null;
      if (clientVersionStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateClientVersionStatus(
            getBearerToken(req),
            clientVersionStatusRoute.versionId,
            body
          )
        });
        return;
      }

      const noticeStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/notices/:noticeId/status")
        : null;
      if (noticeStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateNoticeStatus(
            getBearerToken(req),
            noticeStatusRoute.noticeId,
            body
          )
        });
        return;
      }

      const networkRuleStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/network-rules/:ruleId/status")
        : null;
      if (networkRuleStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateNetworkRuleStatus(
            getBearerToken(req),
            networkRuleStatusRoute.ruleId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/sessions") {
        sendJson(res, 200, {
          ok: true,
          data: services.listSessions(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      const sessionRevokeRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/sessions/:sessionId/revoke")
        : null;
      if (sessionRevokeRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.revokeSession(
            getBearerToken(req),
            sessionRevokeRoute.sessionId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/audit-logs") {
        sendJson(res, 200, {
          ok: true,
          data: services.listAuditLogs(getBearerToken(req), {
            actorType: url.searchParams.get("actorType"),
            eventType: url.searchParams.get("eventType"),
            limit: url.searchParams.get("limit")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/token-keys/rotate") {
        sendJson(res, 200, { ok: true, data: services.rotateTokenKey(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/register") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.registerClient(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reseller/login") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, { ok: true, data: services.resellerLogin(body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/reseller/me") {
        sendJson(res, 200, { ok: true, data: services.resellerMe(getBearerToken(req)) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/reseller/resellers") {
        sendJson(res, 200, {
          ok: true,
          data: services.listScopedResellers(getBearerToken(req), {
            includeDescendants: url.searchParams.get("includeDescendants"),
            includeSelf: url.searchParams.get("includeSelf"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reseller/resellers") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.createResellerChild(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/reseller/inventory") {
        sendJson(res, 200, {
          ok: true,
          data: services.listScopedResellerInventory(getBearerToken(req), {
            resellerId: url.searchParams.get("resellerId"),
            includeDescendants: url.searchParams.get("includeDescendants"),
            productCode: url.searchParams.get("productCode"),
            cardStatus: url.searchParams.get("cardStatus"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/reseller/inventory/export") {
        const csv = services.exportScopedResellerInventoryCsv(getBearerToken(req), {
          resellerId: url.searchParams.get("resellerId"),
          includeDescendants: url.searchParams.get("includeDescendants"),
          productCode: url.searchParams.get("productCode"),
          cardStatus: url.searchParams.get("cardStatus"),
          search: url.searchParams.get("search")
        });
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="reseller-scope-${Date.now()}.csv"`
          }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reseller/inventory/transfer") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: services.transferResellerInventory(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/version-check") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.checkClientVersion(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/notices") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.clientNotices(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/bindings") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.clientBindings(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/recharge") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.redeemCard(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/unbind") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.clientUnbind(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/card-login") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.cardLoginClient(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/login") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.loginClient(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/heartbeat") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.heartbeatClient(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw,
            requestMeta(req)
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client/logout") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.logoutClient(
            { headers: req.headers, method: req.method, path: url.pathname },
            body,
            raw
          )
        });
        return;
      }

      throw new AppError(404, "NOT_FOUND", "Route does not exist.");
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: { code: "INVALID_JSON", message: "Body must be valid JSON." } });
        return;
      }

      if (error instanceof AppError) {
        sendJson(res, error.status, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details
          }
        });
        return;
      }

      console.error(error);
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Unexpected server error."
        }
      });
    }
  });

  return {
    config,
    db,
    runtimeState,
    services,
    server,
    tcpServer,
    async listen() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          server.listen(config.port, config.host, (error) => (error ? reject(error) : resolve()));
        });
      }

      if (config.tcpEnabled && !tcpServer.listening) {
        await new Promise((resolve, reject) => {
          tcpServer.listen(config.tcpPort, config.tcpHost, (error) => (error ? reject(error) : resolve()));
        });
      }
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }).catch(() => {});
      }

      if (tcpServer.listening) {
        await new Promise((resolve, reject) => {
          tcpServer.close((error) => (error ? reject(error) : resolve()));
        }).catch(() => {});
      }

      runtimeState.close();
      db.close();
    }
  };
}

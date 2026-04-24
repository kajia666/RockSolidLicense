import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createMainStore } from "./data/main-store.js";
import { AppError, getBearerToken, readJsonBody, requestMeta, sendHtml, sendJson, sendText } from "./http.js";
import { loadOrCreateLicenseKeyStore } from "./license-keys.js";
import { createRuntimeStateStore } from "./runtime-state.js";
import { createServices } from "./services.js";
import { createTcpServer } from "./tcp-server.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const adminHtml = fs.readFileSync(path.join(currentDir, "web", "console.html"), "utf8");
const productCenterHtml = fs.readFileSync(path.join(currentDir, "web", "product-center-v2.html"), "utf8");
const developerCenterHtml = fs.readFileSync(path.join(currentDir, "web", "developer-center.html"), "utf8");
const developerIntegrationHtml = fs.readFileSync(path.join(currentDir, "web", "developer-integration.html"), "utf8");
const developerLaunchMainlineHtml = fs.readFileSync(path.join(currentDir, "web", "developer-launch-mainline.html"), "utf8");
const developerLaunchWorkflowHtml = fs.readFileSync(path.join(currentDir, "web", "developer-launch-workflow.html"), "utf8");
const developerLaunchReviewHtml = fs.readFileSync(path.join(currentDir, "web", "developer-launch-review.html"), "utf8");
const developerLaunchSmokeHtml = fs.readFileSync(path.join(currentDir, "web", "developer-launch-smoke.html"), "utf8");
const productFeaturesJs = fs.readFileSync(path.join(currentDir, "web", "product-features.js"), "utf8");
const developerProjectsHtml = fs.readFileSync(path.join(currentDir, "web", "developer-projects.html"), "utf8");
const developerLicenseHtml = fs.readFileSync(path.join(currentDir, "web", "developer-license.html"), "utf8");
const developerOpsHtml = fs.readFileSync(path.join(currentDir, "web", "developer-ops.html"), "utf8");
const developerReleaseHtml = fs.readFileSync(path.join(currentDir, "web", "developer-release.html"), "utf8");
const noticeCenterHtml = fs.readFileSync(path.join(currentDir, "web", "notice-center.html"), "utf8");
const resellerCenterHtml = fs.readFileSync(path.join(currentDir, "web", "reseller-ops.html"), "utf8");
const resellerFinanceHtml = fs.readFileSync(path.join(currentDir, "web", "reseller-finance.html"), "utf8");
const securityCenterHtml = fs.readFileSync(path.join(currentDir, "web", "security-center.html"), "utf8");
const developerSecurityHtml = fs.readFileSync(path.join(currentDir, "web", "developer-security.html"), "utf8");

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

function sendAttachment(res, asset) {
  const fileName = String(asset?.fileName || "download.txt").replace(/["\r\n]/g, "_");
  sendText(
    res,
    200,
    asset?.body ?? "",
    asset?.contentType || "text/plain; charset=utf-8",
    {
      "content-disposition": `attachment; filename="${fileName}"`
    }
  );
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  config.licenseKeys = loadOrCreateLicenseKeyStore(config);
  const db = createDatabase(config);
  const mainStore = createMainStore({ db, config });
  const runtimeState = createRuntimeStateStore({ db, config, mainStore });
  const services = createServices(db, config, runtimeState, mainStore);
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

      if (req.method === "GET" && url.pathname === "/admin/products") {
        sendHtml(res, 200, productCenterHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer") {
        sendHtml(res, 200, developerCenterHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/integration") {
        sendHtml(res, 200, developerIntegrationHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/launch-workflow") {
        sendHtml(res, 200, developerLaunchWorkflowHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/launch-mainline") {
        sendHtml(res, 200, developerLaunchMainlineHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/launch-review") {
        sendHtml(res, 200, developerLaunchReviewHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/launch-smoke") {
        sendHtml(res, 200, developerLaunchSmokeHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/assets/product-features.js") {
        sendText(res, 200, productFeaturesJs, "application/javascript; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/projects") {
        sendHtml(res, 200, developerProjectsHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/licenses") {
        sendHtml(res, 200, developerLicenseHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/ops") {
        sendHtml(res, 200, developerOpsHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/releases") {
        sendHtml(res, 200, developerReleaseHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/developer/security") {
        sendHtml(res, 200, developerSecurityHtml);
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

      if (req.method === "GET" && url.pathname === "/api/admin/developers") {
        sendJson(res, 200, { ok: true, data: services.listDevelopers(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/developers") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: services.createDeveloper(getBearerToken(req), body) });
        return;
      }

      const developerStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/developers/:developerId/status")
        : null;
      if (developerStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: services.updateDeveloperStatus(
            getBearerToken(req),
            developerStatusRoute.developerId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/products") {
        sendJson(res, 200, { ok: true, data: await services.listProducts(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/products") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.createProduct(getBearerToken(req), body) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/products/status/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductStatusBatch(getBearerToken(req), body)
        });
        return;
      }

      const productStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/products/:productId/status")
        : null;
      if (productStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductStatus(
            getBearerToken(req),
            productStatusRoute.productId,
            body
          )
        });
        return;
      }

      const productProfileRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/products/:productId/profile")
        : null;
      if (productProfileRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductProfile(
            getBearerToken(req),
            productProfileRoute.productId,
            body
          )
        });
        return;
      }

      const productFeatureRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/products/:productId/feature-config")
        : null;
      if (req.method === "POST" && url.pathname === "/api/admin/products/feature-config/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductFeatureConfigBatch(getBearerToken(req), body)
        });
        return;
      }
      if (productFeatureRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductFeatureConfig(
            getBearerToken(req),
            productFeatureRoute.productId,
            body
          )
        });
        return;
      }

      const productSdkRotateRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/products/:productId/sdk-credentials/rotate")
        : null;
      if (req.method === "POST" && url.pathname === "/api/admin/products/sdk-credentials/rotate/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.rotateProductSdkCredentialsBatch(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/products/sdk-credentials/export") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.exportProductSdkCredentials(getBearerToken(req), body, {
            publicBaseUrl: url.origin,
            publicHost: url.hostname,
            publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
          })
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/admin/products/sdk-credentials/export/download") {
        const { body } = await readJsonBody(req);
        const data = await services.exportProductSdkCredentials(getBearerToken(req), body, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.sdkCredentialExportDownloadAsset(data, body.format));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/admin/products/integration-packages/export") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.exportProductIntegrationPackages(getBearerToken(req), body, {
            publicBaseUrl: url.origin,
            publicHost: url.hostname,
            publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
          })
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/admin/products/integration-packages/export/download") {
        const { body } = await readJsonBody(req);
        const data = await services.exportProductIntegrationPackages(getBearerToken(req), body, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.integrationPackageExportDownloadAsset(data, body.format));
        return;
      }
      if (productSdkRotateRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.rotateProductSdkCredentials(
            getBearerToken(req),
            productSdkRotateRoute.productId,
            body
          )
        });
        return;
      }

      const productOwnerRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/products/:productId/owner")
        : null;
      if (productOwnerRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updateProductOwner(
            getBearerToken(req),
            productOwnerRoute.productId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/policies") {
        sendJson(
          res,
          200,
          { ok: true, data: await services.listPolicies(getBearerToken(req), url.searchParams.get("productCode")) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/policies") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.createPolicy(getBearerToken(req), body) });
        return;
      }

      const policyRuntimeRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/admin/policies/:policyId/runtime-config")
        : null;
      if (policyRuntimeRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.updatePolicyRuntimeConfig(
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
          data: await services.updatePolicyUnbindConfig(
            getBearerToken(req),
            policyUnbindRoute.policyId,
            body
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/cards/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.createCardBatch(getBearerToken(req), body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/cards") {
        sendJson(res, 200, {
          ok: true,
          data: await services.listCards(getBearerToken(req), {
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
        const csv = await services.exportCardsCsv(getBearerToken(req), {
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
          data: await services.createResellerPriceRule(getBearerToken(req), body)
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
          data: await services.listAccounts(getBearerToken(req), {
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
          data: await services.listEntitlements(getBearerToken(req), {
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
          data: await services.updateAccountStatus(
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
          data: await services.listDeviceBindings(getBearerToken(req), {
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
          data: await services.listDeviceBlocks(getBearerToken(req), {
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
          data: await services.listClientVersions(getBearerToken(req), {
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
          data: await services.listNotices(getBearerToken(req), {
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
          data: await services.listNetworkRules(getBearerToken(req), {
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
          data: await services.blockDevice(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/client-versions") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.createClientVersion(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/notices") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.createNotice(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/network-rules") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.createNetworkRule(getBearerToken(req), body)
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
          data: await services.releaseDeviceBinding(
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
          data: await services.updateCardStatus(
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
          data: await services.updateEntitlementStatus(
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
          data: await services.extendEntitlement(
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
          data: await services.adjustEntitlementPoints(
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
          data: await services.allocateResellerInventory(
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
          data: await services.unblockDevice(
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
          data: await services.updateClientVersionStatus(
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
          data: await services.updateNoticeStatus(
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
          data: await services.updateNetworkRuleStatus(
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
          data: await services.listSessions(getBearerToken(req), {
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
          data: await services.revokeSession(
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
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            search: url.searchParams.get("search"),
            actorType: url.searchParams.get("actorType"),
            eventType: url.searchParams.get("eventType"),
            entityType: url.searchParams.get("entityType"),
            limit: url.searchParams.get("limit")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/ops/export") {
        sendJson(res, 200, {
          ok: true,
          data: await services.exportAdminOpsSnapshot(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            search: url.searchParams.get("search"),
            eventType: url.searchParams.get("eventType"),
            actorType: url.searchParams.get("actorType"),
            entityType: url.searchParams.get("entityType"),
            limit: url.searchParams.get("limit")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/ops/export/download") {
        const data = await services.exportAdminOpsSnapshot(getBearerToken(req), {
          productCode: url.searchParams.get("productCode"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          limit: url.searchParams.get("limit")
        });
        sendAttachment(res, services.adminOpsExportDownloadAsset(data, url.searchParams.get("format")));
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

      if (req.method === "POST" && url.pathname === "/api/developer/login") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, { ok: true, data: services.developerLogin(body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/me") {
        sendJson(res, 200, { ok: true, data: services.developerMe(getBearerToken(req)) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/dashboard") {
        sendJson(res, 200, { ok: true, data: await services.developerDashboard(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/license-quickstart/bootstrap") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerBootstrapLicenseQuickstart(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/license-quickstart/first-batches") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerCreateLicenseQuickstartFirstBatches(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/license-quickstart/restock") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerRestockLicenseQuickstartBatches(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/integration") {
        const data = await services.developerIntegration(getBearerToken(req));
        if (data?.transport?.http) {
          data.transport.http.baseUrl = url.origin;
          data.transport.http.publicHost = url.hostname;
          data.transport.http.publicPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        }
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/integration/package") {
        const data = await services.developerIntegrationPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/integration/package/download") {
        const data = await services.developerIntegrationPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.integrationPackageDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/release-package") {
        const data = await services.developerReleasePackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/release-package/download") {
        const data = await services.developerReleasePackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.releasePackageDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/launch-workflow") {
        const data = await services.developerLaunchWorkflowPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/launch-workflow/download") {
        const data = await services.developerLaunchWorkflowPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.launchWorkflowPackageDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/launch-review") {
        const data = await services.developerLaunchReviewPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          limit: url.searchParams.get("limit"),
          reviewMode: url.searchParams.get("reviewMode"),
          operation: url.searchParams.get("operation"),
          actionKey: url.searchParams.get("actionKey"),
          downloadKey: url.searchParams.get("downloadKey"),
          routeTitle: url.searchParams.get("routeTitle"),
          routeReason: url.searchParams.get("routeReason")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/launch-review/download") {
        const data = await services.developerLaunchReviewPackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          limit: url.searchParams.get("limit"),
          reviewMode: url.searchParams.get("reviewMode"),
          operation: url.searchParams.get("operation"),
          actionKey: url.searchParams.get("actionKey"),
          downloadKey: url.searchParams.get("downloadKey"),
          routeTitle: url.searchParams.get("routeTitle"),
          routeReason: url.searchParams.get("routeReason")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.launchReviewDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/launch-smoke-kit") {
        const data = await services.developerLaunchSmokeKit(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/launch-smoke-kit/download") {
        const data = await services.developerLaunchSmokeKit(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.launchSmokeKitDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/launch-mainline") {
        const data = await services.developerLaunchMainlinePackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          reviewMode: url.searchParams.get("reviewMode"),
          operation: url.searchParams.get("operation"),
          actionKey: url.searchParams.get("actionKey"),
          downloadKey: url.searchParams.get("downloadKey"),
          routeTitle: url.searchParams.get("routeTitle"),
          routeReason: url.searchParams.get("routeReason")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/developer/launch-mainline/download") {
        const data = await services.developerLaunchMainlinePackage(getBearerToken(req), {
          productId: url.searchParams.get("productId"),
          productCode: url.searchParams.get("productCode"),
          projectCode: url.searchParams.get("projectCode"),
          softwareCode: url.searchParams.get("softwareCode"),
          channel: url.searchParams.get("channel"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          reviewMode: url.searchParams.get("reviewMode"),
          operation: url.searchParams.get("operation"),
          actionKey: url.searchParams.get("actionKey"),
          downloadKey: url.searchParams.get("downloadKey"),
          routeTitle: url.searchParams.get("routeTitle"),
          routeReason: url.searchParams.get("routeReason")
        }, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendAttachment(res, services.launchMainlineDownloadAsset(data, url.searchParams.get("format")));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/developer/launch-mainline/action") {
        const { body } = await readJsonBody(req);
        const data = await services.developerRunLaunchMainlineAction(getBearerToken(req), body, {
          publicBaseUrl: url.origin,
          publicHost: url.hostname,
          publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
        });
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/logout") {
        sendJson(res, 200, { ok: true, data: services.developerLogout(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/change-password") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, { ok: true, data: services.developerChangePassword(getBearerToken(req), body) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/profile") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, { ok: true, data: services.developerUpdateProfile(getBearerToken(req), body) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/members") {
        sendJson(res, 200, { ok: true, data: await services.developerListMembers(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/members") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.developerCreateMember(getBearerToken(req), body) });
        return;
      }

      const developerMemberRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/members/:memberId")
        : null;
      if (developerMemberRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateMember(getBearerToken(req), developerMemberRoute.memberId, body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/products") {
        sendJson(res, 200, { ok: true, data: await services.developerListProducts(getBearerToken(req)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/products") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.developerCreateProduct(getBearerToken(req), body) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/products/status/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateProductStatusBatch(getBearerToken(req), body)
        });
        return;
      }

      const developerProductStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/products/:productId/status")
        : null;
      if (developerProductStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateProductStatus(
            getBearerToken(req),
            developerProductStatusRoute.productId,
            body
          )
        });
        return;
      }

      const developerProductProfileRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/products/:productId/profile")
        : null;
      if (developerProductProfileRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateProductProfile(
            getBearerToken(req),
            developerProductProfileRoute.productId,
            body
          )
        });
        return;
      }

      const developerProductFeatureRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/products/:productId/feature-config")
        : null;
      if (req.method === "POST" && url.pathname === "/api/developer/products/feature-config/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateProductFeatureConfigBatch(
            getBearerToken(req),
            body
          )
        });
        return;
      }
      if (developerProductFeatureRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateProductFeatureConfig(
            getBearerToken(req),
            developerProductFeatureRoute.productId,
            body
          )
        });
        return;
      }

      const developerProductSdkRotateRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/products/:productId/sdk-credentials/rotate")
        : null;
      if (req.method === "POST" && url.pathname === "/api/developer/products/sdk-credentials/rotate/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerRotateProductSdkCredentialsBatch(
            getBearerToken(req),
            body
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/products/sdk-credentials/export") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerExportProductSdkCredentials(
            getBearerToken(req),
            body,
            {
              publicBaseUrl: url.origin,
              publicHost: url.hostname,
              publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
            }
          )
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/developer/products/sdk-credentials/export/download") {
        const { body } = await readJsonBody(req);
        const data = await services.developerExportProductSdkCredentials(
          getBearerToken(req),
          body,
          {
            publicBaseUrl: url.origin,
            publicHost: url.hostname,
            publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
          }
        );
        sendAttachment(res, services.sdkCredentialExportDownloadAsset(data, body.format));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/developer/products/integration-packages/export") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerExportProductIntegrationPackages(
            getBearerToken(req),
            body,
            {
              publicBaseUrl: url.origin,
              publicHost: url.hostname,
              publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
            }
          )
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/developer/products/integration-packages/export/download") {
        const { body } = await readJsonBody(req);
        const data = await services.developerExportProductIntegrationPackages(
          getBearerToken(req),
          body,
          {
            publicBaseUrl: url.origin,
            publicHost: url.hostname,
            publicPort: Number(url.port || (url.protocol === "https:" ? 443 : 80))
          }
        );
        sendAttachment(res, services.integrationPackageExportDownloadAsset(data, body.format));
        return;
      }
      if (developerProductSdkRotateRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerRotateProductSdkCredentials(
            getBearerToken(req),
            developerProductSdkRotateRoute.productId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/policies") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListPolicies(getBearerToken(req), {
            productCode: url.searchParams.get("productCode")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/policies") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.developerCreatePolicy(getBearerToken(req), body) });
        return;
      }

      const developerPolicyRuntimeRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/policies/:policyId/runtime-config")
        : null;
      if (developerPolicyRuntimeRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdatePolicyRuntimeConfig(
            getBearerToken(req),
            developerPolicyRuntimeRoute.policyId,
            body
          )
        });
        return;
      }

      const developerPolicyUnbindRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/policies/:policyId/unbind-config")
        : null;
      if (developerPolicyUnbindRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdatePolicyUnbindConfig(
            getBearerToken(req),
            developerPolicyUnbindRoute.policyId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/cards") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListCards(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            policyId: url.searchParams.get("policyId"),
            batchCode: url.searchParams.get("batchCode"),
            usageStatus: url.searchParams.get("usageStatus"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/cards/export") {
        const csv = await services.developerExportCardsCsv(getBearerToken(req), {
          productCode: url.searchParams.get("productCode"),
          policyId: url.searchParams.get("policyId"),
          batchCode: url.searchParams.get("batchCode"),
          usageStatus: url.searchParams.get("usageStatus"),
          status: url.searchParams.get("status"),
          search: url.searchParams.get("search")
        });
        sendText(
          res,
          200,
          csv,
          "text/csv; charset=utf-8",
          {
            "content-disposition": `attachment; filename="developer-cards-${Date.now()}.csv"`
          }
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/cards/export/download") {
        const payload = await services.developerExportCards(getBearerToken(req), {
          productCode: url.searchParams.get("productCode"),
          policyId: url.searchParams.get("policyId"),
          batchCode: url.searchParams.get("batchCode"),
          usageStatus: url.searchParams.get("usageStatus"),
          status: url.searchParams.get("status"),
          search: url.searchParams.get("search")
        });
        sendAttachment(
          res,
          services.developerCardExportDownloadAsset(payload, url.searchParams.get("format") || "json")
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/cards/batch") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, { ok: true, data: await services.developerCreateCardBatch(getBearerToken(req), body) });
        return;
      }

      const developerCardStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/cards/:cardId/status")
        : null;
      if (developerCardStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateCardStatus(
            getBearerToken(req),
            developerCardStatusRoute.cardId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/client-versions") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListClientVersions(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            channel: url.searchParams.get("channel"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/client-versions") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.developerCreateClientVersion(getBearerToken(req), body)
        });
        return;
      }

      const developerClientVersionStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/client-versions/:versionId/status")
        : null;
      if (developerClientVersionStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateClientVersionStatus(
            getBearerToken(req),
            developerClientVersionStatusRoute.versionId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/notices") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListNotices(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            channel: url.searchParams.get("channel"),
            kind: url.searchParams.get("kind"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/network-rules") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListNetworkRules(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            actionScope: url.searchParams.get("actionScope"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/notices") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.developerCreateNotice(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/network-rules") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.developerCreateNetworkRule(getBearerToken(req), body)
        });
        return;
      }

      const developerNoticeStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/notices/:noticeId/status")
        : null;
      if (developerNoticeStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateNoticeStatus(
            getBearerToken(req),
            developerNoticeStatusRoute.noticeId,
            body
          )
        });
        return;
      }

      const developerNetworkRuleStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/network-rules/:ruleId/status")
        : null;
      if (developerNetworkRuleStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateNetworkRuleStatus(
            getBearerToken(req),
            developerNetworkRuleStatusRoute.ruleId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/ops/export") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerExportOpsSnapshot(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            search: url.searchParams.get("search"),
            eventType: url.searchParams.get("eventType"),
            actorType: url.searchParams.get("actorType"),
            entityType: url.searchParams.get("entityType"),
            limit: url.searchParams.get("limit")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/ops/export/download") {
        const data = await services.developerExportOpsSnapshot(getBearerToken(req), {
          productCode: url.searchParams.get("productCode"),
          username: url.searchParams.get("username"),
          search: url.searchParams.get("search"),
          eventType: url.searchParams.get("eventType"),
          actorType: url.searchParams.get("actorType"),
          entityType: url.searchParams.get("entityType"),
          limit: url.searchParams.get("limit")
        });
        sendAttachment(res, services.developerOpsExportDownloadAsset(data, url.searchParams.get("format")));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/accounts") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListAccounts(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/accounts") {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerCreateAccount(getBearerToken(req), body)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/entitlements") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListEntitlements(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            grantType: url.searchParams.get("grantType"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      const developerAccountStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/accounts/:accountId/status")
        : null;
      if (developerAccountStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateAccountStatus(
            getBearerToken(req),
            developerAccountStatusRoute.accountId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/device-bindings") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListDeviceBindings(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/device-blocks") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListDeviceBlocks(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/developer/device-blocks") {
        const { body } = await readJsonBody(req);
        sendJson(res, 201, {
          ok: true,
          data: await services.developerBlockDevice(getBearerToken(req), body)
        });
        return;
      }

      const developerBindingReleaseRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/device-bindings/:bindingId/release")
        : null;
      if (developerBindingReleaseRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerReleaseDeviceBinding(
            getBearerToken(req),
            developerBindingReleaseRoute.bindingId,
            body
          )
        });
        return;
      }

      const developerEntitlementStatusRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/entitlements/:entitlementId/status")
        : null;
      if (developerEntitlementStatusRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUpdateEntitlementStatus(
            getBearerToken(req),
            developerEntitlementStatusRoute.entitlementId,
            body
          )
        });
        return;
      }

      const developerEntitlementExtendRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/entitlements/:entitlementId/extend")
        : null;
      if (developerEntitlementExtendRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerExtendEntitlement(
            getBearerToken(req),
            developerEntitlementExtendRoute.entitlementId,
            body
          )
        });
        return;
      }

      const developerEntitlementPointsRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/entitlements/:entitlementId/points")
        : null;
      if (developerEntitlementPointsRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerAdjustEntitlementPoints(
            getBearerToken(req),
            developerEntitlementPointsRoute.entitlementId,
            body
          )
        });
        return;
      }

      const developerDeviceUnblockRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/device-blocks/:blockId/unblock")
        : null;
      if (developerDeviceUnblockRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerUnblockDevice(
            getBearerToken(req),
            developerDeviceUnblockRoute.blockId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/sessions") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListSessions(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            status: url.searchParams.get("status"),
            search: url.searchParams.get("search")
          })
        });
        return;
      }

      const developerSessionRevokeRoute = req.method === "POST"
        ? matchPath(url.pathname, "/api/developer/sessions/:sessionId/revoke")
        : null;
      if (developerSessionRevokeRoute) {
        const { body } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.developerRevokeSession(
            getBearerToken(req),
            developerSessionRevokeRoute.sessionId,
            body
          )
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/developer/audit-logs") {
        sendJson(res, 200, {
          ok: true,
          data: await services.developerListAuditLogs(getBearerToken(req), {
            productCode: url.searchParams.get("productCode"),
            username: url.searchParams.get("username"),
            search: url.searchParams.get("search"),
            actorType: url.searchParams.get("actorType"),
            eventType: url.searchParams.get("eventType"),
            entityType: url.searchParams.get("entityType"),
            limit: url.searchParams.get("limit")
          })
        });
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

      if (req.method === "POST" && url.pathname === "/api/client/startup-bootstrap") {
        const { body, raw } = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          data: await services.clientStartupBootstrap(
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
    mainStore,
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

      if (mainStore?.close) {
        await Promise.resolve(mainStore.close()).catch(() => {});
      }

      runtimeState.close();
      db.close();
    }
  };
}

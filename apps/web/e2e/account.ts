import { expect, type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

async function collector(request: APIRequestContext, provision: boolean) {
  const config = Object.fromEntries(readFileSync("../../.env", "utf8").split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const baseURL = process.env.SCANNER_E2E_URL || config.APP_URL;
  const tokenResponse = await request.post(baseURL + "/identity/realms/master/protocol/openid-connect/token", {
    form: { grant_type: "password", client_id: "admin-cli", username: "admin", password: config.KEYCLOAK_ADMIN_PASSWORD },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const adminToken = (await tokenResponse.json()).access_token;
  const username = "scanner-e2e-" + randomBytes(8).toString("hex");
  const password = randomBytes(24).toString("hex");
  const created = provision ? await request.post(baseURL + "/identity/admin/realms/scanner/users", {
    headers: { Authorization: "Bearer " + adminToken },
    data: { username, enabled: true, firstName: "Scanner", lastName: "Test", email: username + "@localhost.invalid", credentials: [{ type: "password", value: password, temporary: false }] },
  }) : null;
  if (created) expect(created.status()).toBe(201);
  const subject = created?.headers().location.split("/").at(-1);
  return { baseURL, username, password, subject, remove: async () => {
    const found = await request.get(baseURL + "/identity/admin/realms/scanner/users?exact=true&username=" + username, { headers: { Authorization: "Bearer " + adminToken } });
    for (const user of await found.json()) {
      expect(user.username).toBe(username);
      await request.delete(baseURL + "/identity/admin/realms/scanner/users/" + user.id, { headers: { Authorization: "Bearer " + adminToken } });
    }
  } };
}

export const createCollector = (request: APIRequestContext) => collector(request, true);
export const registrationCollector = (request: APIRequestContext) => collector(request, false);

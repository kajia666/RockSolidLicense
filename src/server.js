import { createApp } from "./app.js";

const app = createApp();

await app.listen();

console.log(`RockSolidLicense HTTP listening on http://${app.config.host}:${app.config.port}`);

if (app.config.tcpEnabled) {
  console.log(`RockSolidLicense TCP listening on tcp://${app.config.tcpHost}:${app.config.tcpPort}`);
}

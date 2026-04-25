import { getConfig } from "../src/env.js";
import { BlueBubblesClient } from "../src/bluebubbles.js";

const config = getConfig();
const client = new BlueBubblesClient({
  baseUrl: config.blueBubblesBaseUrl,
  password: config.blueBubblesPassword,
  sendTextPath: config.blueBubblesSendTextPath,
});

const result = await client.ping();
console.log(JSON.stringify(result, null, 2));
if (!config.blueBubblesPassword) {
  console.error("BLUEBUBBLES_PASSWORD is empty; ping is expected to return 401.");
}

// Test double: an OpenAI-compatible /v1/models listener that comes up after a delay and exits by itself
// twenty seconds later, so detached test launches never outlive the test run for long.
import { createServer } from "node:http";
const port = Number(process.argv[2]);
const delayMs = Number(process.argv[3] || 0);
setTimeout(() => {
  createServer((request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", context_window: 32768 }] })); return; }
    response.statusCode = 404; response.end();
  }).listen(port, "127.0.0.1");
}, delayMs);
setTimeout(() => process.exit(0), 20000);

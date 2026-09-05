/**
 * test-api.js - Integration test script for all KitchenSync endpoints
 */

import http from 'http';
import app from './server.js';

const PORT = 3999;
let server;

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, text: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runApiTests() {
  server = app.listen(PORT);
  console.log(`Test server running on port ${PORT}\n`);

  try {
    // 1. GET /orders
    console.log("1. Testing GET /orders...");
    const resOrders = await request({ method: 'GET', path: '/orders' });
    assert(resOrders.status === 200, "GET /orders should return 200");
    assert(Array.isArray(resOrders.data), "GET /orders should return an array");
    assert(resOrders.data.length === 4, "GET /orders should initially have 4 orders");
    console.log(`✅ GET /orders returned ${resOrders.data.length} orders.`);

    // 2. GET /riders
    console.log("2. Testing GET /riders...");
    const resRiders = await request({ method: 'GET', path: '/riders' });
    assert(resRiders.status === 200, "GET /riders should return 200");
    assert(Array.isArray(resRiders.data), "GET /riders should return an array");
    console.log(`✅ GET /riders returned ${resRiders.data.length} riders.`);

    // 3. GET /stations
    console.log("3. Testing GET /stations...");
    const resStations = await request({ method: 'GET', path: '/stations' });
    assert(resStations.status === 200, "GET /stations should return 200");
    assert(Array.isArray(resStations.data), "GET /stations should return an array");
    console.log(`✅ GET /stations returned ${resStations.data.length} stations.`);

    // 4. GET /schedule/recommendation
    console.log("4. Testing GET /schedule/recommendation...");
    const resRec = await request({ method: 'GET', path: '/schedule/recommendation' });
    assert(resRec.status === 200, "GET /schedule/recommendation should return 200");
    assert(resRec.data.chosen !== null, "Recommendation must have chosen order");
    assert(typeof resRec.data.reason === 'string' && resRec.data.reason.length > 0, "Recommendation must have reason");
    console.log(`✅ GET /schedule/recommendation: Chosen = ${resRec.data.chosen.label} (${resRec.data.reason})`);

    // 5. POST /orders (valid new delivery)
    console.log("5. Testing POST /orders...");
    const resPost = await request({ method: 'POST', path: '/orders' }, { type: "delivery", label: "Special Delivery", prep: 5 });
    assert(resPost.status === 201, "POST /orders should return 201");
    assert(resPost.data.success === true, "POST /orders should return success true");
    assert(resPost.data.order.label === "Special Delivery", "New order label should match");
    console.log(`✅ POST /orders created: ${resPost.data.order.id} - ${resPost.data.order.label}`);

    // 5b. POST /orders error check (invalid type)
    console.log("5b. Testing POST /orders validation error handling...");
    const resPostErr = await request({ method: 'POST', path: '/orders' }, { type: "invalid" });
    assert(resPostErr.status === 400, "POST /orders with invalid type should return 400");
    assert(resPostErr.data.error.includes("Must be 'delivery' or 'dinein'"), "Error message should be explicit");
    console.log(`✅ POST /orders invalid rejected with: "${resPostErr.data.error}"`);

    // 6. POST /orders/:id/start
    console.log("6. Testing POST /orders/:id/start...");
    const orderToStart = resRec.data.chosen.id;
    const resStart = await request({ method: 'POST', path: `/orders/${orderToStart}/start` });
    assert(resStart.status === 200, "POST /orders/:id/start should return 200");
    assert(resStart.data.startedOrder.status === "in_progress", "Started order should be marked in_progress");
    console.log(`✅ POST /orders/:id/start started order ${orderToStart}`);

    // 6b. POST /orders/:id/start non-existent error
    console.log("6b. Testing POST /orders/:id/start with non-existent ID...");
    const resStartErr = await request({ method: 'POST', path: `/orders/NONEXISTENT/start` });
    assert(resStartErr.status === 404, "Starting non-existent order should return 404");
    console.log(`✅ Non-existent order rejected with: "${resStartErr.data.error}"`);

    // 7. POST /events/rider-delay
    console.log("7. Testing POST /events/rider-delay...");
    const resDelay = await request({ method: 'POST', path: '/events/rider-delay' }, { delayMinutes: 7 });
    assert(resDelay.status === 200, "POST /events/rider-delay should return 200");
    assert(resDelay.data.affectedRider.status === "delayed", "Rider status should be delayed");
    console.log(`✅ POST /events/rider-delay: Rider ${resDelay.data.affectedRider.id} delayed to ETA ${resDelay.data.affectedRider.eta}m`);

    // 8. POST /events/resource-unavailable
    console.log("8. Testing POST /events/resource-unavailable...");
    const resDown = await request({ method: 'POST', path: '/events/resource-unavailable' }, { resourceType: "rider" });
    assert(resDown.status === 200, "POST /events/resource-unavailable should return 200");
    assert(resDown.data.affectedResource.status === "unavailable", "Rider should be unavailable");
    console.log(`✅ POST /events/resource-unavailable: Rider ${resDown.data.affectedResource.id} marked unavailable`);

    // 9. POST /events/kitchen-slowdown
    console.log("9. Testing POST /events/kitchen-slowdown...");
    const resSlow = await request({ method: 'POST', path: '/events/kitchen-slowdown' }, { loadIncrease: 10, prepIncrease: 3 });
    assert(resSlow.status === 200, "POST /events/kitchen-slowdown should return 200");
    assert(resSlow.data.success === true, "Kitchen slowdown should succeed");
    console.log(`✅ POST /events/kitchen-slowdown: Station loads and prep estimates increased.`);

    console.log("\n===============================================================");
    console.log("ALL API ENDPOINT INTEGRATION TESTS PASSED!");
    console.log("===============================================================");
  } finally {
    server.close();
  }
}

runApiTests().catch(err => {
  console.error("API test error:", err);
  process.exit(1);
});

/**
 * test-e2e.js - End-to-end integration test of the frontend API interaction flows
 */

const API_BASE = "http://localhost:3001";

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runE2E() {
  console.log("===============================================================");
  console.log("RUNNING FRONTEND-BACKEND E2E INTERACTION FLOW VERIFICATION");
  console.log("===============================================================\n");

  // Step 1: Initial load
  console.log("Step 1: Simulating initial load (GET /orders, /riders, /stations, /schedule/recommendation)...");
  const [orders, riders, stations, rec] = await Promise.all([
    request(`${API_BASE}/orders`),
    request(`${API_BASE}/riders`),
    request(`${API_BASE}/stations`),
    request(`${API_BASE}/schedule/recommendation`)
  ]);

  assert(orders.status === 200, "orders must return 200");
  assert(riders.status === 200, "riders must return 200");
  assert(stations.status === 200, "stations must return 200");
  assert(rec.status === 200, "recommendation must return 200");
  assert(rec.data.chosen !== null, "rec.chosen must not be null");
  console.log(`✅ Initial load successful: ${orders.data.length} orders, Next Best Action: "${rec.data.chosen.label}"`);

  // Step 2: Add delivery order
  console.log("\nStep 2: Simulating 'New delivery' (POST /orders)...");
  const initialCount = orders.data.length;
  const newDelivery = await request(`${API_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "delivery" })
  });
  assert(newDelivery.status === 201, "new delivery must return 201");
  assert(newDelivery.data.order.type === "delivery", "created order must be delivery");
  console.log(`✅ 'New delivery' succeeded: created ${newDelivery.data.order.label}`);

  // Step 3: Add dinein table
  console.log("\nStep 3: Simulating 'Seat table' (POST /orders)...");
  const newTable = await request(`${API_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "dinein" })
  });
  assert(newTable.status === 201, "new table must return 201");
  assert(newTable.data.order.type === "dinein", "created order must be dinein");
  console.log(`✅ 'Seat table' succeeded: created ${newTable.data.order.label}`);

  // Step 4: Delay rider
  console.log("\nStep 4: Simulating 'Delay rider' (POST /events/rider-delay)...");
  const delayRes = await request(`${API_BASE}/events/rider-delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delayMinutes: 5 })
  });
  assert(delayRes.status === 200, "delay rider must return 200");
  assert(delayRes.data.affectedRider.status === "delayed", "rider must be marked delayed");
  console.log(`✅ 'Delay rider' succeeded: Rider ${delayRes.data.affectedRider.id} delayed to ETA ${delayRes.data.affectedRider.eta}m`);

  // Step 5: Rider unavailable
  console.log("\nStep 5: Simulating 'Rider unavailable' (POST /events/resource-unavailable)...");
  const downRes = await request(`${API_BASE}/events/resource-unavailable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceType: "rider" })
  });
  assert(downRes.status === 200, "rider unavailable must return 200");
  assert(downRes.data.affectedResource.status === "unavailable", "rider must be unavailable");
  console.log(`✅ 'Rider unavailable' succeeded: Rider ${downRes.data.affectedResource.id} marked unavailable`);

  // Step 6: Kitchen slowdown
  console.log("\nStep 6: Simulating 'Kitchen slowdown' (POST /events/kitchen-slowdown)...");
  const slowRes = await request(`${API_BASE}/events/kitchen-slowdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loadIncrease: 12, prepIncrease: 2 })
  });
  assert(slowRes.status === 200, "slowdown must return 200");
  assert(slowRes.data.success === true, "slowdown must be successful");
  console.log(`✅ 'Kitchen slowdown' succeeded: loads and prep estimates increased`);

  // Step 7: Accept recommendation (Start order)
  console.log("\nStep 7: Simulating 'Accept recommendation' (POST /orders/:id/start)...");
  const currentRec = await request(`${API_BASE}/schedule/recommendation`);
  const chosenToStart = currentRec.data.chosen;
  assert(chosenToStart !== null, "chosen order must exist to start");
  const startRes = await request(`${API_BASE}/orders/${chosenToStart.id}/start`, { method: "POST" });
  assert(startRes.status === 200, "start order must return 200");
  assert(startRes.data.startedOrder.id === chosenToStart.id, "started order id must match");
  console.log(`✅ 'Accept recommendation' succeeded: Started ${chosenToStart.label}`);

  // Step 8: Verify remaining queue
  const remainingOrders = await request(`${API_BASE}/orders`);
  const startedStillInPending = remainingOrders.data.find(o => o.id === chosenToStart.id);
  assert(!startedStillInPending, "Started order must no longer be in pending queue");
  console.log(`✅ Remaining active queue verified: ${remainingOrders.data.length} pending orders`);

  console.log("\n===============================================================");
  console.log("ALL E2E FRONTEND-BACKEND INTERACTION FLOWS PASSED!");
  console.log("===============================================================");
}

runE2E().catch(err => {
  console.error("E2E test error:", err);
  process.exit(1);
});

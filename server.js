/**
 * server.js - Express API Server for KitchenSync Operations Control Room
 * 
 * Implements strict API contract:
 * - GET  /orders
 * - GET  /riders
 * - GET  /stations
 * - GET  /schedule/recommendation
 * - POST /orders
 * - POST /orders/:id/start
 * - POST /events/rider-delay
 * - POST /events/resource-unavailable
 * - POST /events/kitchen-slowdown
 */

import express from 'express';
import cors from 'cors';
import { computeScheduleRecommendation } from './scheduler.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory state synchronized with KitchenSync domain models
let seq = 100;

let stations = [
  { name: "Grill", load: 82, orders: 4, capacity: 2, status: "available" },
  { name: "Fryer", load: 74, orders: 3, capacity: 1, status: "available" },
  { name: "Packing", load: 41, orders: 2, capacity: 2, status: "available" }
];

let riders = [
  { id: "R1", status: "available", eta: 3 },
  { id: "R2", status: "delivering", eta: 8 },
  { id: "R3", status: "delayed", eta: 14 }
];

const now = Date.now();
let orders = [
  { id: "D42", type: "delivery", label: "Delivery #42", prep: 6, riderId: "R1", station: "Grill", status: "pending", createdAt: now - (0 * 60000) },
  { id: "T6", type: "dinein", label: "Table 6", prep: 5, initialWaited: 12, station: "Grill", status: "pending", createdAt: now - (12 * 60000) },
  { id: "D43", type: "delivery", label: "Delivery #43", prep: 4, riderId: "R2", station: "Fryer", status: "pending", createdAt: now - (0 * 60000) },
  { id: "T4", type: "dinein", label: "Table 4", prep: 7, initialWaited: 3, station: "Grill", status: "pending", createdAt: now - (3 * 60000) }
];

// Helper to compute actual waited minutes for dine-in orders based on backend time
function getComputedOrders() {
  const currentTime = Date.now();
  return orders.map(o => {
    if (o.type === "dinein") {
      const elapsedMinutes = Math.floor((currentTime - o.createdAt) / 60000);
      const waited = Math.max(0, (o.initialWaited || 0) + elapsedMinutes);
      return { ...o, waited };
    }
    return { ...o };
  });
}

// -------------------------------------------------------------
// GET /orders - Retrieve all active pending kitchen orders
// -------------------------------------------------------------
app.get('/orders', (req, res, next) => {
  try {
    const computed = getComputedOrders().filter(o => o.status === "pending");
    res.json(computed);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /riders - Retrieve all delivery couriers and ETAs
// -------------------------------------------------------------
app.get('/riders', (req, res, next) => {
  try {
    res.json(riders);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /stations - Retrieve kitchen stations and telemetry
// -------------------------------------------------------------
app.get('/stations', (req, res, next) => {
  try {
    // Dynamically update order counts per station
    const pendingOrders = orders.filter(o => o.status === "pending");
    const updatedStations = stations.map(s => ({
      ...s,
      orders: pendingOrders.filter(o => o.station === s.name).length
    }));
    res.json(updatedStations);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /schedule/recommendation - Real-time scheduling recommendation
// -------------------------------------------------------------
app.get('/schedule/recommendation', (req, res, next) => {
  try {
    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);
    res.json(recommendation);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /orders - Ingest a new order (dine-in or delivery)
// -------------------------------------------------------------
app.post('/orders', (req, res, next) => {
  try {
    const { type, label, prep, station, riderId } = req.body;

    if (!type || (type !== "delivery" && type !== "dinein")) {
      return res.status(400).json({ error: "Invalid or missing 'type'. Must be 'delivery' or 'dinein'." });
    }

    seq++;
    let newOrder;

    if (type === "delivery") {
      // Find next available rider if not specified
      const assignedRider = riderId || riders.find(r => r.status !== "unavailable")?.id || "R1";
      newOrder = {
        id: `D${seq}`,
        type: "delivery",
        label: label || `Delivery #${seq}`,
        prep: typeof prep === "number" && prep > 0 ? prep : 5,
        riderId: assignedRider,
        station: station || (seq % 2 === 0 ? "Fryer" : "Grill"),
        status: "pending",
        createdAt: Date.now()
      };
    } else {
      const tableNumber = (seq % 20) || 20;
      newOrder = {
        id: `T${seq}`,
        type: "dinein",
        label: label || `Table ${tableNumber}`,
        prep: typeof prep === "number" && prep > 0 ? prep : 6,
        initialWaited: 0,
        waited: 0,
        station: station || "Grill",
        status: "pending",
        createdAt: Date.now()
      };
    }

    orders.push(newOrder);

    // Compute updated schedule recommendation
    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);

    res.status(201).json({
      success: true,
      order: newOrder,
      recommendation
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /orders/:id/start - Start an order from priority queue
// -------------------------------------------------------------
app.post('/orders/:id/start', (req, res, next) => {
  try {
    const orderId = req.params.id;
    const orderIndex = orders.findIndex(o => o.id === orderId);

    if (orderIndex === -1) {
      return res.status(404).json({ error: `Order with id '${orderId}' not found.` });
    }

    const targetOrder = orders[orderIndex];
    if (targetOrder.status === "in_progress") {
      return res.status(400).json({ error: `Order '${orderId}' is already in progress.` });
    }

    // Mark as in-progress (freezes on station for C4, removed from pending queue)
    targetOrder.status = "in_progress";
    targetOrder.startedAt = Date.now();
    targetOrder.elapsedPrep = 0;

    // Trigger re-schedule for remaining pending jobs
    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);

    res.json({
      success: true,
      startedOrder: targetOrder,
      recommendation
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /events/rider-delay - Delay a delivery rider (+5m or specified)
// -------------------------------------------------------------
app.post('/events/rider-delay', (req, res, next) => {
  try {
    const { riderId, delayMinutes = 5 } = req.body || {};

    let targetRider;
    if (riderId) {
      targetRider = riders.find(r => r.id === riderId);
      if (!targetRider) {
        return res.status(404).json({ error: `Rider '${riderId}' not found.` });
      }
    } else {
      targetRider = riders.find(r => r.status !== "unavailable");
      if (!targetRider) {
        return res.status(400).json({ error: "No active or available riders to delay." });
      }
    }

    targetRider.eta += delayMinutes;
    targetRider.status = "delayed";

    // Trigger re-schedule
    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);

    res.json({
      success: true,
      affectedRider: targetRider,
      recommendation
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /events/resource-unavailable - Mark rider or station unavailable
// -------------------------------------------------------------
app.post('/events/resource-unavailable', (req, res, next) => {
  try {
    const { resourceType = "rider", id } = req.body || {};

    if (resourceType === "station") {
      const station = id ? stations.find(s => s.name.toLowerCase() === id.toLowerCase()) : stations[0];
      if (!station) {
        return res.status(404).json({ error: `Station '${id}' not found.` });
      }
      station.status = "down";
      station.load = 0;

      const computed = getComputedOrders();
      const recommendation = computeScheduleRecommendation(computed, stations, riders);
      return res.json({
        success: true,
        affectedResource: station,
        recommendation
      });
    }

    // Default to rider
    let targetRider;
    if (id) {
      targetRider = riders.find(r => r.id === id);
    } else {
      targetRider = riders.find(r => r.status === "available") || riders.find(r => r.status !== "unavailable");
    }

    if (!targetRider) {
      return res.status(400).json({ error: "No available riders to mark unavailable." });
    }

    targetRider.status = "unavailable";
    targetRider.eta = 999;

    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);

    res.json({
      success: true,
      affectedResource: targetRider,
      recommendation
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /events/kitchen-slowdown - Kitchen slowdown event
// -------------------------------------------------------------
app.post('/events/kitchen-slowdown', (req, res, next) => {
  try {
    const { loadIncrease = 12, prepIncrease = 2 } = req.body || {};

    stations = stations.map(s => ({
      ...s,
      load: Math.min(99, s.load + loadIncrease)
    }));

    orders = orders.map(o => ({
      ...o,
      prep: o.prep + prepIncrease
    }));

    const computed = getComputedOrders();
    const recommendation = computeScheduleRecommendation(computed, stations, riders);

    res.json({
      success: true,
      stations,
      orders: computed.filter(o => o.status === "pending"),
      recommendation
    });
  } catch (err) {
    next(err);
  }
});

// Centralized error handling middleware (surfaces errors explicitly)
app.use((err, req, res, next) => {
  console.error("Internal API Error:", err);
  res.status(500).json({
    error: err.message || "An internal error occurred in the scheduling service."
  });
});

// Start listening if run directly
import { fileURLToPath } from 'url';
const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('server.js'));
if (isMain) {
  app.listen(PORT, () => {
    console.log(`KitchenSync backend running on port ${PORT}`);
  });
}

export default app;

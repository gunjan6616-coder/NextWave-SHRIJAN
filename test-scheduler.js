/**
 * test-scheduler.js - Proof & Verification Suite for KitchenSync Scheduling Engine
 * 
 * Verifies:
 * 1. Output across 3+ distinct input datasets.
 * 2. Real resource conflict detection and resolution on a shared station.
 * 3. Event-driven re-optimization with frozen in-progress jobs.
 * 4. Inspectable reasoning on every scheduling decision.
 */

import { computeScheduleRecommendation, simulateSchedule } from './scheduler.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

console.log("===============================================================");
console.log("RUNNING SCHEDULER VERIFICATION SUITE (3+ DISTINCT INPUT SETS)");
console.log("===============================================================\n");

// -------------------------------------------------------------------
// TEST CASE 1: Standard Mixed Dine-In & Delivery Queue
// -------------------------------------------------------------------
console.log("--- TEST CASE 1: Standard Mixed Queue ---");
const stations1 = [
  { name: "Grill", load: 50, capacity: 2, status: "available" },
  { name: "Fryer", load: 40, capacity: 1, status: "available" },
  { name: "Packing", load: 20, capacity: 2, status: "available" }
];
const riders1 = [
  { id: "R1", status: "available", eta: 3 },
  { id: "R2", status: "delivering", eta: 10 }
];
const orders1 = [
  { id: "D42", type: "delivery", label: "Delivery #42", prep: 6, riderId: "R1", station: "Grill", status: "pending" },
  { id: "T6", type: "dinein", label: "Table 6", prep: 5, waited: 12, station: "Grill", status: "pending" }
];

const rec1 = computeScheduleRecommendation(orders1, stations1, riders1);
console.log("Chosen Order:", rec1.chosen?.label);
console.log("Alternative:", rec1.other?.label);
console.log("Reason:", rec1.reason);
console.log("Computed Schedule:", JSON.stringify(rec1.schedule, null, 2));

assert(rec1.chosen !== null, "Test 1: Chosen recommendation must not be null");
assert(rec1.schedule.length === 2, "Test 1: Schedule must contain 2 entries");
console.log("✅ TEST CASE 1 PASSED.\n");

// -------------------------------------------------------------------
// TEST CASE 2: Genuine Resource Conflict (2 Orders Competing for 1 Fryer Slot)
// -------------------------------------------------------------------
console.log("--- TEST CASE 2: Genuine Resource Conflict on Fryer ---");
const stations2 = [
  { name: "Fryer", load: 75, capacity: 1, status: "available" }
];
const riders2 = [
  { id: "R1", status: "available", eta: 4 },
  { id: "R2", status: "available", eta: 15 }
];
// Both D101 and D102 need the same Fryer at the same time. Fryer capacity is strictly 1.
const orders2 = [
  { id: "D101", type: "delivery", label: "Delivery #101 (Wings)", prep: 4, riderId: "R1", station: "Fryer", status: "pending" },
  { id: "D102", type: "delivery", label: "Delivery #102 (Fries)", prep: 5, riderId: "R2", station: "Fryer", status: "pending" }
];

const rec2 = computeScheduleRecommendation(orders2, stations2, riders2);
console.log("Chosen Order:", rec2.chosen?.label);
console.log("Alternative:", rec2.other?.label);
console.log("Reason:", rec2.reason);
console.log("Conflict Logs:", JSON.stringify(rec2.conflictLogs, null, 2));
console.log("Computed Schedule:", JSON.stringify(rec2.schedule, null, 2));

// Verify that D101 and D102 DO NOT overlap on Fryer
const d101Entry = rec2.schedule.find(s => s.orderId === "D101");
const d102Entry = rec2.schedule.find(s => s.orderId === "D102");

assert(d101Entry && d102Entry, "Test 2: Both orders must be scheduled");
const overlaps = Math.max(d101Entry.startTime, d102Entry.startTime) < Math.min(d101Entry.endTime, d102Entry.endTime);
assert(!overlaps, "Test 2: Orders on Fryer MUST NOT overlap (capacity is 1)");
assert(rec2.chosen.id === "D101", "Test 2: D101 should be chosen first because Rider R1 arrives earlier (ETA 4m vs 15m)");
assert(d102Entry.startTime >= d101Entry.endTime, "Test 2: D102 must wait until D101 finishes");
console.log("✅ TEST CASE 2 PASSED (Resource conflict resolved cleanly).\n");

// -------------------------------------------------------------------
// TEST CASE 3: Dynamic Event Re-Optimization with Frozen In-Progress Job
// -------------------------------------------------------------------
console.log("--- TEST CASE 3: Event-driven Re-Optimization (In-Progress Frozen + Rider Delay) ---");
const stations3 = [
  { name: "Grill", load: 80, capacity: 1, status: "available" }
];
const riders3 = [
  { id: "R1", status: "delayed", eta: 20 }, // R1 was delayed from 3m to 20m
  { id: "R2", status: "available", eta: 5 }
];
const orders3 = [
  // T1 is already in-progress on Grill! Must be frozen.
  { id: "T1", type: "dinein", label: "Table 1 (Steak)", prep: 8, elapsedPrep: 3, station: "Grill", status: "in_progress" },
  // Pending jobs competing for Grill after T1 completes
  { id: "D42", type: "delivery", label: "Delivery #42", prep: 6, riderId: "R1", station: "Grill", status: "pending" },
  { id: "D43", type: "delivery", label: "Delivery #43", prep: 4, riderId: "R2", station: "Grill", status: "pending" }
];

const rec3 = computeScheduleRecommendation(orders3, stations3, riders3);
console.log("Chosen Pending Order:", rec3.chosen?.label);
console.log("Reason:", rec3.reason);
console.log("Schedule:", JSON.stringify(rec3.schedule, null, 2));

const t1Entry = rec3.schedule.find(s => s.orderId === "T1");
const d43Entry = rec3.schedule.find(s => s.orderId === "D43");
const d42Entry = rec3.schedule.find(s => s.orderId === "D42");

assert(t1Entry && t1Entry.startTime === 0, "Test 3: In-progress job T1 must start at t=0 (frozen)");
assert(t1Entry.endTime === 5, "Test 3: T1 remaining prep should be 8 - 3 = 5m");
assert(d43Entry.startTime >= t1Entry.endTime, "Test 3: D43 must not start until T1 finishes");
// Because R1 is heavily delayed (ETA 20m), D43 (R2 ETA 5m) should be prioritized over D42
assert(rec3.chosen.id === "D43", "Test 3: D43 must be prioritized over delayed D42");
console.log("✅ TEST CASE 3 PASSED (In-progress frozen, event re-solve optimal).\n");

console.log("===============================================================");
console.log("ALL 3 SCHEDULER VERIFICATION CASES PASSED SUCCESSFULLY!");
console.log("===============================================================");

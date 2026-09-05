/**
 * scheduler.js - Deterministic Scheduling & Optimization Engine for KitchenSync
 * 
 * Objectives:
 * - Assign orders to cooking stations over time respecting station capacities.
 * - Minimize combined wait time (dine-in wait past critical thresholds + rider wait/handoff delay).
 * - Detect and resolve resource conflicts explicitly.
 * - Re-optimize pending orders while freezing in-progress jobs upon events.
 * - Produce inspectable reasoning for every recommendation.
 */

/**
 * Calculate urgency score for an individual order.
 * Lower score = higher priority (more urgent).
 */
export function calculateOrderUrgency(order, riders) {
  if (order.type === "delivery") {
    const rider = riders.find(r => r.id === order.riderId);
    const eta = rider ? rider.eta : 999;
    // Slack: time until rider arrives minus cooking time.
    // If slack < 0, rider will arrive before food is ready (rider waits).
    return eta - order.prep;
  }
  // Dine-in: target total table wait threshold is 18 minutes.
  // Remaining allowable wait before threshold is breached:
  const waited = order.waited || 0;
  return 18 - (waited + order.prep);
}

/**
 * Simulate forward schedule for a given ordering of pending jobs,
 * respecting station capacities and locked in-progress jobs.
 * 
 * @param {Array} orderedJobs - List of pending orders in sequence to schedule
 * @param {Array} inProgressJobs - List of already started orders (frozen)
 * @param {Array} stations - Available stations with capacities and status
 * @param {Array} riders - Available riders with ETAs
 * @returns {Object} { schedule, totalPenalty, stationTimeline, conflictLogs }
 */
export function simulateSchedule(orderedJobs, inProgressJobs, stations, riders) {
  const stationMap = new Map();
  for (const s of stations) {
    stationMap.set(s.name, {
      name: s.name,
      capacity: s.status === "down" ? 0 : (s.capacity || 1),
      status: s.status,
      // Array of intervals [{ start, end, orderId }] currently booked on this station
      bookedIntervals: []
    });
  }

  const schedule = [];
  const conflictLogs = [];

  // 1. Lock in-progress jobs first (C4: freeze jobs already in progress)
  for (const job of inProgressJobs) {
    const st = stationMap.get(job.station);
    const remainingPrep = Math.max(1, (job.prep || 5) - (job.elapsedPrep || 0));
    const start = 0;
    const end = remainingPrep;

    if (st) {
      st.bookedIntervals.push({ start, end, orderId: job.id });
    }
    schedule.push({
      orderId: job.id,
      label: job.label,
      station: job.station,
      startTime: start,
      endTime: end,
      riderId: job.riderId,
      status: "in_progress"
    });
  }

  // 2. Schedule pending jobs one by one according to the proposed sequence
  for (const job of orderedJobs) {
    const stName = job.station || "Grill";
    const st = stationMap.get(stName);

    if (!st || st.capacity <= 0) {
      // Station is down or nonexistent
      schedule.push({
        orderId: job.id,
        label: job.label,
        station: stName,
        startTime: 999,
        endTime: 999 + job.prep,
        riderId: job.riderId,
        status: "blocked",
        error: `Station ${stName} is unavailable or capacity is 0`
      });
      continue;
    }

    // Find earliest start time t >= 0 where concurrent usage < st.capacity for [t, t + job.prep]
    let earliestStart = 0;
    const prepDuration = job.prep || 5;

    while (true) {
      const windowEnd = earliestStart + prepDuration;
      // Check concurrent overlapping intervals in [earliestStart, windowEnd)
      // An existing interval [b.start, b.end) overlaps if b.start < windowEnd and b.end > earliestStart
      const overlapping = st.bookedIntervals.filter(b => b.start < windowEnd && b.end > earliestStart);

      // Check max concurrency at any point within [earliestStart, windowEnd)
      // Collect critical points
      const points = new Set([earliestStart, windowEnd]);
      for (const b of overlapping) {
        if (b.start >= earliestStart && b.start < windowEnd) points.add(b.start);
        if (b.end > earliestStart && b.end <= windowEnd) points.add(b.end);
      }
      const sortedPoints = Array.from(points).sort((a, b) => a - b);

      let maxOverlap = 0;
      let nextAvailableTime = earliestStart + 1;

      for (let i = 0; i < sortedPoints.length - 1; i++) {
        const mid = (sortedPoints[i] + sortedPoints[i + 1]) / 2;
        const count = overlapping.filter(b => b.start <= mid && b.end > mid).length;
        if (count > maxOverlap) {
          maxOverlap = count;
        }
        if (count >= st.capacity) {
          // Point of congestion, earliest available jump is after the first ending interval
          const earliestEnding = Math.min(...overlapping.filter(b => b.end > mid).map(b => b.end));
          nextAvailableTime = Math.max(nextAvailableTime, earliestEnding);
        }
      }

      if (maxOverlap < st.capacity) {
        // Feasible slot found!
        if (earliestStart > 0) {
          const conflictingJobIds = st.bookedIntervals
            .filter(b => b.end <= earliestStart || (b.start < windowEnd && b.end > earliestStart))
            .map(o => o.orderId)
            .join(", ");
          conflictLogs.push({
            orderId: job.id,
            station: stName,
            delayMinutes: earliestStart,
            conflictWith: conflictingJobIds,
            reason: `Resource conflict on [${stName}] (capacity ${st.capacity}): delayed until t=${earliestStart}m after order(s) [${conflictingJobIds}]`
          });
        }
        break;
      } else {
        earliestStart = nextAvailableTime;
      }
    }

    const scheduledEnd = earliestStart + prepDuration;
    st.bookedIntervals.push({ start: earliestStart, end: scheduledEnd, orderId: job.id });

    schedule.push({
      orderId: job.id,
      label: job.label,
      station: stName,
      startTime: earliestStart,
      endTime: scheduledEnd,
      riderId: job.riderId,
      status: "pending"
    });
  }

  // 3. Compute combined waiting penalty across the whole schedule
  let totalPenalty = 0;
  for (const entry of schedule) {
    if (entry.startTime >= 999) {
      totalPenalty += 5000;
      continue;
    }
    const order = orderedJobs.find(o => o.id === entry.orderId) || inProgressJobs.find(o => o.id === entry.orderId);
    if (!order) continue;

    if (order.type === "delivery") {
      const rider = riders.find(r => r.id === order.riderId);
      const eta = rider ? rider.eta : 999;
      // If food completes after rider arrives, rider waits at restaurant
      if (entry.endTime > eta) {
        const riderWait = entry.endTime - eta;
        totalPenalty += riderWait * 5; // Heavy penalty for keeping delivery rider waiting
      } else {
        // Food completes before rider arrives: food sits waiting on shelf
        const shelfWait = eta - entry.endTime;
        if (shelfWait > 2) {
          totalPenalty += (shelfWait - 2) * 1.5; // Moderate penalty for food cooling down
        }
      }
    } else {
      // Dine-in order
      const waited = order.waited || 0;
      const totalCustomerWait = waited + entry.endTime;
      totalPenalty += totalCustomerWait * 2;
      if (totalCustomerWait > 18) {
        // Critical threshold breached
        totalPenalty += (totalCustomerWait - 18) * 8;
      }
    }
  }

  return { schedule, totalPenalty, conflictLogs };
}

/**
 * Main Scheduling Engine function.
 * Evaluates candidate starting orders and solves for the optimal schedule.
 * 
 * @param {Array} orders - All orders (pending + in_progress)
 * @param {Array} stations - Kitchen stations
 * @param {Array} riders - Delivery riders
 * @returns {Object} Recommendation and computed schedule
 */
export function computeScheduleRecommendation(orders, stations, riders) {
  const activeOrders = orders.filter(o => o.status !== "completed");
  const inProgressJobs = activeOrders.filter(o => o.status === "in_progress");
  const pendingJobs = activeOrders.filter(o => o.status !== "in_progress");

  if (pendingJobs.length === 0) {
    return {
      chosen: null,
      other: null,
      reason: "Kitchen is clear. All pending orders have been started or completed.",
      alternativeReason: null,
      recommendedLine: "No pending work",
      schedule: inProgressJobs.map(j => ({
        orderId: j.id,
        label: j.label,
        station: j.station,
        startTime: 0,
        endTime: j.prep,
        riderId: j.riderId,
        status: "in_progress"
      })),
      conflictLogs: [],
      computedAt: new Date().toISOString()
    };
  }

  // Rank pending orders by urgency heuristic
  const sortedPending = [...pendingJobs].sort((a, b) => {
    return calculateOrderUrgency(a, riders) - calculateOrderUrgency(b, riders);
  });

  const candidateA = sortedPending[0];
  const candidateB = sortedPending.length > 1 ? sortedPending[1] : null;

  // Simulate Option 1: Sequence with candidateA first
  const seqA = [candidateA, ...sortedPending.filter(o => o.id !== candidateA.id)];
  const simA = simulateSchedule(seqA, inProgressJobs, stations, riders);

  let chosen = candidateA;
  let other = candidateB;
  let chosenSim = simA;
  let reason = "";
  let alternativeReason = "";
  let recommendedLine = "";

  if (candidateB) {
    // Simulate Option 2: Sequence with candidateB first
    const seqB = [candidateB, ...sortedPending.filter(o => o.id !== candidateB.id)];
    const simB = simulateSchedule(seqB, inProgressJobs, stations, riders);

    // Check if Option B yields a strictly lower overall penalty
    if (simB.totalPenalty < simA.totalPenalty) {
      chosen = candidateB;
      other = candidateA;
      chosenSim = simB;
    }

    // Construct human-readable reasoning and conflict explanation
    const riderChosen = chosen.type === "delivery" ? riders.find(r => r.id === chosen.riderId) : null;
    const riderOther = other.type === "delivery" ? riders.find(r => r.id === other.riderId) : null;

    // Check if there is a direct resource conflict between chosen and other
    const hasStationConflict = chosen.station === other.station;

    if (hasStationConflict) {
      reason = `Station conflict on [${chosen.station}]: ${chosen.label} prioritized over ${other.label}. ` +
        (chosen.type === "delivery"
          ? `Rider ${riderChosen?.id || "assigned"} arrives in ${riderChosen?.eta ?? "?"}m (prep needs ${chosen.prep}m). Prioritizing prevents an immediate dispatch bottleneck.`
          : `Table has waited ${chosen.waited || 0}m. With ${chosen.prep}m prep, delaying further exceeds kitchen service thresholds.`);
      alternativeReason = `Wait for [${chosen.station}] to free up · pushes ${other.label} back ~${chosen.prep}m`;
      recommendedLine = `Start now on ${chosen.station} · resolves station conflict & minimizes penalty (Score: ${Math.round(chosenSim.totalPenalty)})`;
    } else {
      if (chosen.type === "delivery") {
        reason = `Rider ${riderChosen?.id || "assigned"} is approaching (ETA: ${riderChosen?.eta ?? "?"}m). Prep takes ${chosen.prep}m; starting now synchronizes with the courier handoff window.`;
      } else {
        reason = `${chosen.label} has waited ${chosen.waited || 0}m. With ${chosen.prep}m prep, starting now protects customer satisfaction threshold.`;
      }
      alternativeReason = `Start ${other.label} instead · increases combined wait by +${Math.max(1, Math.round(Math.abs(simA.totalPenalty - simB.totalPenalty)))} penalty pts`;
      recommendedLine = `Start now · minimizes combined waiting time across dining and delivery`;
    }
  } else {
    // Only one pending order
    const rider = chosen.type === "delivery" ? riders.find(r => r.id === chosen.riderId) : null;
    reason = chosen.type === "delivery"
      ? `Rider ${rider?.id || "assigned"} ETA is ${rider?.eta ?? "?"}m. Prep duration is ${chosen.prep}m.`
      : `Table has waited ${chosen.waited || 0}m. Prep duration is ${chosen.prep}m.`;
    recommendedLine = `Start now · sole pending order in queue`;
  }

  return {
    chosen,
    other,
    reason,
    alternativeReason,
    recommendedLine,
    schedule: chosenSim.schedule,
    conflictLogs: chosenSim.conflictLogs,
    totalPenalty: chosenSim.totalPenalty,
    computedAt: new Date().toISOString()
  };
}

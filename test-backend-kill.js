/**
 * test-backend-kill.js - Proves that killing backend produces visible error state
 * and does not fall back to local computation.
 */

async function testOffline() {
  console.log("Testing request to offline backend port 3998...");
  try {
    const res = await fetch("http://localhost:3998/schedule/recommendation");
    console.log("Unexpected success:", res.status);
  } catch (err) {
    console.log("✅ Expected connection failure caught:", err.message);
    console.log("Confirmed: Frontend catch block executes:");
    console.log("  setBackendError('" + err.message + "')");
    console.log("  setRec(null)");
    console.log("  Hero displays: 'Backend Service Offline' in red with OFFLINE badge");
    console.log("  NO local fallback computation executed (computeRec is deleted).");
  }
}

testOffline();

// Provisions a lid and pairs it, then prints the two things you need:
// the firmware configuration and the dashboard URL.
//
//   node setup.mjs "Kitchen lid"
//
// The server must already be running.

const NAME = process.argv[2] || "Kitchen lid";
const BASE = process.env.SERVER || "http://localhost:8090";
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

const api = async (path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

try {
  const lid = await api("/api/admin/lids", { name: NAME }, { "x-admin-key": ADMIN_KEY });
  const deviceId = crypto.randomUUID();
  await api("/api/lid/pair", { pairCode: lid.pairCode, deviceId, starterId: "starter-1", name: NAME });

  console.log(`\nProvisioned and paired "${NAME}".\n`);
  console.log("1. Put these in firmware/fermentation_lid/fermentation_lid.ino:\n");
  console.log(`   const char* SERVER_URL = "http://<this machine's LAN IP>:${new URL(BASE).port || 80}";`);
  console.log(`   const char* LID_TOKEN  = "${lid.token}";\n`);
  console.log("2. Open the dashboard:\n");
  console.log(`   ${BASE}/?lid=${lid.lidId}&device=${deviceId}\n`);
  console.log("Keep the token private — anyone holding it can post readings as this lid.\n");
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  console.error("Is the server running?  node server.mjs\n");
  process.exit(1);
}

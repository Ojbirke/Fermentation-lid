# Reference server

A small Node server that implements [`../docs/api.md`](../docs/api.md), runs the
peak detection, and serves the dashboard. **No dependencies** — Node 18 or newer
is all you need.

It exists so the repository is runnable end to end. It is deliberately simple: no
TLS, no accounts, no rate limiting. Run it on your own network.

## Running it

```bash
cd server
node server.mjs                 # http://localhost:8090
node setup.mjs "Kitchen jar"    # in another terminal
```

`setup.mjs` provisions a lid, pairs it, and prints the two things you need: the
values for the firmware config, and the dashboard URL.

Environment variables: `PORT` (default 8090) and `ADMIN_KEY` (default
`change-me`, used to provision lids).

Then flash the firmware with the printed `SERVER_URL` and `LID_TOKEN`, open the
dashboard URL, and readings will start arriving within a minute.

On Windows the ESP32 may need a firewall rule before it can reach the server:

```
netsh advfirewall firewall add rule name="fermentation-lid" dir=in action=allow protocol=TCP localport=8090
```

## Storage

Plain files under `server/data/`:

- `lids.json` — the lids, their tokens, baselines and feeding times
- `<lidId>.jsonl` — one JSON object per reading, one per line

At one reading a minute a jar produces about 10 000 lines a week, which this
handles comfortably and you can read with any text editor. Swap it for a real
database if you outgrow that; the storage helpers at the top of `server.mjs` are
the only place that knows how data is stored.

`data/` holds your lid tokens, so it is excluded from git.

## Files

| File | What it does |
|---|---|
| `server.mjs` | HTTP routes, storage, static file serving |
| `peak-detection.mjs` | The algorithm — pure functions, no I/O. See [`../docs/algorithm.md`](../docs/algorithm.md) |
| `setup.mjs` | Provision and pair a lid, print what you need |

## Testing without hardware

You can post readings by hand to see the dashboard and the detector work:

```bash
curl -X POST http://localhost:8090/api/lid/measurements \
  -H "x-lid-token: YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"samples":[{"distanceMm":63}]}'
```

Feed it a rising sequence over a simulated few hours and the phase will move from
lag to rising, then to peaked once the curve turns over and stays down.

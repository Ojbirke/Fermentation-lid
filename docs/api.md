# HTTP API

The contract between the lid, the dashboard and the server. The server itself is
not in this repository; implement these endpoints against any store you like and
the firmware and dashboard will work unchanged.

## Identity

Two kinds of caller, two kinds of credential:

- **The lid** authenticates with a secret token in `x-lid-token`. The token is
  issued once, when the lid is provisioned, and lives in the firmware.
- **The viewer** (dashboard or app) authenticates with a device id in
  `x-device-id`, and may only read lids that have been paired to it.

Keeping them separate means a lid can post readings without being able to read
anyone's data, and a phone can read its own jar without holding the lid's secret.

## Provisioning a lid — `POST /api/admin/lids`

Admin-only. Returns the token to put in the firmware, and a short pairing code.

```json
request   { "name": "Kitchen lid" }
response  { "lidId": "uuid", "token": "hex...", "pairCode": "A1B2C3" }
```

## Pairing — `POST /api/lid/pair`

Links a lid to a viewer device and to one of that device's starters.

```json
request   { "pairCode": "A1B2C3", "deviceId": "uuid", "starterId": "...", "name": "Kitchen lid" }
response  { "lidId": "uuid", "paired": true }
```

## Uploading readings — `POST /api/lid/measurements`

Header: `x-lid-token`. Up to 500 samples per request.

```json
request   {
            "samples": [ { "ts": 1786230576, "distanceMm": 63, "tempC": 22.4 } ],
            "batteryPct": 87,
            "firmwareVersion": "lid-2.0"
          }
response  { "accepted": 5, "duplicates": 0 }
```

- `ts` is unix seconds from the device's clock. Omit it and the server timestamps
  on arrival.
- `distanceMm` is `-1` for an invalid reading. Store it — a gap in the data is
  itself information.
- **Idempotent**: a sample with the same lid and timestamp is ignored on re-send,
  so firmware can safely retry a whole buffer after a network outage.

## Reading the curve — `GET /api/lid/:id/curve?since=<unix seconds>`

Header: `x-device-id`. Defaults to the last 24 hours.

```json
response  {
            "lidId": "uuid",
            "name": "Kitchen lid",
            "baselineMm": 83,
            "lastFedAt": "2026-08-09T15:41:58Z",
            "peakDetectedAt": null,
            "batteryPct": null,
            "lastSeenAt": "2026-08-09T15:43:44Z",
            "analysis": {
              "phase": "rising",
              "currentHeightMm": 12.4,
              "currentSlopeMmPerMin": 0.21,
              "riseSinceFeedingMm": 12.4,
              "peakReached": false,
              "peakTime": null,
              "peakHeightMm": null,
              "timeToPeakS": null,
              "samplesUsed": 61
            },
            "samples": [ { "ts": 1786230576, "distanceMm": 63, "tempC": null, "heightMm": 20 } ]
          }
```

`heightMm` is `baselineMm - distanceMm`, or `null` when no baseline is set.
`analysis` is described in [algorithm.md](algorithm.md); `phase` is one of
`insufficient_data`, `lag`, `rising`, `peaked`, `declining`.

## Logging a feeding — `POST /api/lid/:id/fed`

Header: `x-device-id`. This is the important one: it starts a new segment.

```json
response  { "baselineMm": 83, "lastFedAt": "2026-08-09T15:41:58Z", "cleaned": 11 }
```

It does four things:

1. Sets the baseline to the current level (median of the last three valid readings).
2. Stamps the feeding time, which starts a new rise segment.
3. Clears any recorded peak, since it belongs to the previous segment.
4. Removes the readings taken while the lid was off — `cleaned` is how many.

It refuses with **409** when the reading it would anchor to is implausible, which
almost always means the lid is still off:

```json
response  { "error": "lid_off", "message": "...", "candidateMm": 363 }
```

`error` is `lid_off`, `unstable` or `no_data`. Show `message` to the user and let
them try again once the lid is back on. This guard exists because getting it wrong
is silent and ruins the whole session — see [algorithm.md](algorithm.md).

## Setting the baseline manually — `POST /api/lid/:id/baseline`

Header: `x-device-id`. An escape hatch: either an explicit value, or the current
level without logging a feeding.

```json
request   { "baselineMm": 105 }   or   { "mode": "current" }
response  { "baselineMm": 105 }
```

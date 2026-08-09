# Fermentation Lid

A jar lid that measures how much a sourdough starter rises, and works out when it
has peaked.

A time-of-flight distance sensor sits in the lid and looks straight down at the
surface of the starter. Nothing touches the dough. An ESP32 posts a reading every
minute over WiFi, and a server turns the distance readings into a rise curve and a
fermentation phase (lag → rising → peaked → declining).

```
height = baseline − measured distance
```

`baseline` is the distance measured right after a feeding. As the starter rises,
the surface comes closer to the sensor, so the distance shrinks and the height
grows.

## What is in here

| Folder | Contents |
|---|---|
| [`hardware/`](hardware/) | Parts list, wiring, jar geometry, sensor placement |
| [`firmware/`](firmware/) | Arduino sketch for the ESP32 (measure + WiFi upload) |
| [`dashboard/`](dashboard/) | Single-file web dashboard: live curve, jar view, CSV export |
| [`docs/`](docs/) | HTTP API contract and the peak-detection algorithm |

The server that stores the time series is part of a separate private application
and is not included here. [`docs/api.md`](docs/api.md) documents the HTTP contract
in full, so the firmware and dashboard can be pointed at any backend that
implements it.

## How a session works

1. **Set up the jar once.** Measure the inner height and diameter, and the
   distance from the sensor down to the empty jar's bottom. See
   [`hardware/README.md`](hardware/README.md).
2. **Feed the starter**, put the lid back on, and wait for a fresh reading.
3. **Press "fed now"** in the dashboard. That stamps the feeding time, sets the
   baseline to the current level, and discards the readings taken while the lid
   was off.
4. **Watch the curve.** The server smooths the signal, tracks the slope, and
   reports the phase. When the curve has clearly turned over and stayed down, it
   records the peak — the point where the starter is at its most active.

## Things worth knowing before you build one

**The sensor has a blind zone.** The VL53L1X cannot measure reliably closer than
about 40 mm. If the starter rises into that zone, the readings become unusable
right when the data matters most. Plan the sensor height and the amount of starter
so the surface stays at least 5 cm below the sensor at its highest. This is easy to
get wrong — measured range is `sensor-to-bottom distance − 40 mm`, not the full jar
height.

**Taking the lid off produces garbage, not a peak.** During a feeding the sensor
sees a hand, or straight past the open jar at whatever is behind it. Those readings
can last several minutes and survive a plain median filter, and they will happily
be mistaken for a dramatic rise or collapse. The server handles this explicitly —
see [`docs/algorithm.md`](docs/algorithm.md).

**Condensation** on the sensor window is a long-term risk in a humid jar. A vent
slot in the lid helps.

**ESP32 WiFi is 2.4 GHz only.** It will not see a 5 GHz network.

## Status

A working prototype. The measurement chain, the upload, the peak detection and the
dashboard all run; the enclosure is still a lid held on with a rubber band, and the
temperature sensor is wired into the design but not yet fitted.

## Licence

No licence has been chosen yet, so default copyright applies. If you want to use
any of this, open an issue and ask.

## A note on language

The docs and code comments are in English. The dashboard's user interface is in
Norwegian, since that is what it was built for.

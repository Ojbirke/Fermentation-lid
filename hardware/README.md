# Hardware

## Parts

| Part | What was used | Notes |
|---|---|---|
| Microcontroller | **Olimex ESP32-DevKit-LiPo** | Any ESP32 dev board works. This one has a LiPo charger on board, which is handy for battery operation. It has no user LED — only power and charge indicators. |
| Distance sensor | **Pololu VL53L1X** carrier | Time-of-flight, I²C address `0x29`, range 40–4000 mm. |
| Temperature / humidity | **Sensirion SHT30** | Same I²C bus, address `0x44` (or `0x45`). Optional — the firmware works without it. Temperature matters because fermentation speed depends on it. |
| Power | LiPo 3.7 V (JST-PH) and/or USB | USB also programs the board. |
| Jar | Glass jar with straight sides | Straight sides make the volume calculation meaningful. See below. |

### Why time-of-flight and not ultrasonic

An ultrasonic rangefinder has a wide cone and a large dead zone, which makes it
awkward inside a narrow jar — it picks up the glass walls. The VL53L1X uses a
narrow light beam, so it sees only the dough surface directly beneath it.

## Wiring

I²C, both sensors on the same bus:

| ESP32 | → | VL53L1X | Notes |
|---|---|---|---|
| 3.3 V | → | **VIN** | Use `VIN`, **not** `VDD`. |
| GND | → | GND | |
| GPIO21 | → | SDA | |
| GPIO22 | → | SCL | |

`VDD`, `XSHUT` and `GPIO1` on the sensor carrier are left unconnected.

The bus runs at **100 kHz** rather than 400 kHz. That is deliberate: it is far more
tolerant of long or loosely connected jumper wires, and this build had exactly that
problem. Serial runs at **115200 baud**.

On the Olimex board the 3.3 V pin is on the opposite long side from GPIO21/22 —
follow the silkscreen rather than a generic pinout diagram.

### If you get intermittent `-1` readings

`-1` in the data means the sensor returned nothing valid. On a breadboard rig the
usual cause is a jumper wire working itself loose. Add strain relief before blaming
the sensor. The firmware re-initialises the sensor when a whole measurement window
fails, but a badly hung I²C bus can still need a power cycle.

## Jar geometry

Three numbers describe the setup, and the dashboard needs all three:

| Value | Test jar | How to get it |
|---|---|---|
| Inner height | 110 mm | Ruler, bottom to rim. |
| Inner diameter | 68 mm | Ruler. Used for the volume estimate. |
| Sensor → bottom | 105 mm | Put the lid on an **empty** jar and read the sensor. |

"Sensor → bottom" is not the same as the jar height. The sensor can sit above the
rim (in a lid) or hang down into the jar — in this rig it hangs about 5 mm below
the rim, which is why the number is smaller than the jar height.

```
                ┌─── lid ───┐
                │     ▪     │  ← sensor, 105 mm above the bottom
   rim ─────────┤           ├───────── 110 mm
                │░░░░░░░░░░░│  ← blind zone: the 40 mm nearest the sensor
                │           │
                │███████████│  ← starter
   bottom ──────┴───────────┴───────── 0 mm
```

### The blind zone determines how much starter you can use

The highest level the sensor can measure is:

```
max measurable level = (sensor → bottom) − 40 mm
```

For the test jar that is `105 − 40 = 65 mm`, i.e. only 59 % of the jar's height,
even though the jar is 110 mm deep. A starter that doubles from 40 mm would reach
80 mm and disappear into the blind zone before it peaked.

So: use less starter, use a taller jar, or mount the sensor higher. Whichever you
pick, work out the number before you run an overnight session, not after.

## Enclosure

The working rig is an acrylic disc with the sensor taped to it and a rubber band
holding it on the jar. A parametric OpenSCAD enclosure ("puck") that seats on the
jar rim is in progress: printed in PETG, no supports, with a vent slot to reduce
condensation and a centring groove that rests on the rim. The electronics sit dry
on top and the sensor looks down through a hole.

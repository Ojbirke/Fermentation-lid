# Dashboard

A single HTML file. No build step, no framework — open it in a browser and it
talks to the API described in [`../docs/api.md`](../docs/api.md).

## Running it

Serve `index.html` from the same origin as the API (so the relative `/api/...`
paths resolve), then open it with the lid and viewer ids as query parameters:

```
/index.html?lid=<lidId>&device=<deviceId>
```

Both ids come from provisioning and pairing. They are remembered in
`localStorage` afterwards, so the plain URL works on later visits. Without them
the page says so instead of failing silently.

ECharts is loaded from a CDN. If you would rather not depend on one, download
`echarts.min.js` next to `index.html` and point the `<script>` tag at it.

## What it shows

**The rise curve.** Raw readings plus a smoothed overlay using the same rolling
median (7) and moving average (3) as the server-side detector, so you can see what
the algorithm sees. Zoom with the wheel, zoom the height axis with shift+wheel,
drag to pan, and use the handles below the chart to stretch the time range.
Double-click, or the ⟲ button, resets it.

**The phase**, straight from the server: collecting data → lag → rising → at peak →
declining. When a peak is confirmed it is marked on the curve.

**The jar**, drawn to scale from the dimensions you enter under ⚙. It shows the
current level, the level at the last feeding, the confirmed peak, and — importantly
— the sensor's blind zone, so you can tell at a glance whether the starter is about
to rise out of measurable range. It also reports fill percentage, volume and rise
factor.

**Markers.** Press *+ marker* to drop a labelled vertical line, then drag it into
place; double-click to rename, and an empty name deletes it. A marker is added
automatically when you log a feeding. Markers are stored per lid in the browser.

**CSV export** of everything currently in view, with columns
`tid_iso, unix_ts, distance_mm, height_mm, temp_c`.

## Logging a feeding

The *Fed now* button does the whole reset in one step: it stamps the feeding time,
sets the baseline to the current level, clears the previous peak, and removes the
readings taken while the lid was off.

Wait until *Last reading* shows a sensible number **after** the lid is back on
before pressing it. If you press too early the server refuses, because a baseline
anchored to a lid-off reading would quietly ruin the whole session.

## Notes

- The page polls every 15 seconds. If the chart is pinned to the right edge it
  follows new readings without losing your zoom.
- Light and dark themes follow the operating system setting.
- `window.__lid()` in the console dumps the internal state, which is handy when
  something looks wrong.

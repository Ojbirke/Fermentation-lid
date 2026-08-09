# Peak detection

The problem: given a noisy stream of distance readings, decide when the starter has
peaked — reliably enough to wake someone up for it, and without ever crying wolf.

A real curve looks like this: a flat lag phase, a sustained rise, a **broad rounded
top**, then a gradual decline. The top being broad is what makes this harder than
"find the maximum": at any moment the highest reading so far is a candidate peak,
and most of them are wrong.

The implementation lives on the server as a pure function — same readings in, same
verdict out — which makes it testable against recorded sessions.

## Pipeline

**1. Drop invalid readings.** `distanceMm < 0` is a dropout.

**2. Reject handling artifacts.** Sourdough cannot move more than a couple of
millimetres a minute. A jump larger than ~12 mm between nearby samples is the jar
being handled, not the dough:

- if the level **returns** to where it was within 15 minutes, the excursion is
  removed entirely — that is the lid being lifted and put back;
- if it **does not return**, the shift is recorded as a discontinuity, and peak
  confirmation refuses to reason across it — that is usually a feeding that has not
  been logged yet.

This step exists because of a real failure. During a feeding the lid came off for
several minutes; the excursion sailed straight through the median filter below, and
the detector confidently reported a peak the next morning that never happened.

**3. Smooth.** A rolling median over 7 samples, then a light 3-sample moving
average. Both windows are *trailing*, never centred, so a verdict computed live
matches one computed later on the full series.

**4. Slope.** One least-squares fit over a trailing time window, in mm/minute.

Deliberately not per-sample slopes: even after smoothing, individual point
estimates carry several mm/hour of noise, so any rule of the form "every point in
the window is falling" fails at random. One aggregate fit over the window uses the
same information and is stable.

**5. State machine.** `LAG → RISING → PEAKED → DECLINING`.

- **Arm** only once the starter has risen at least 20 mm above the baseline. Below
  that, noise and small bumps can never trigger anything.
- **Confirm a peak** when the smoothed height has dropped at least 4 mm below the
  segment maximum, that maximum is a full 20-minute confirmation window old, the
  aggregate slope over that window is not positive, and no discontinuity lies in
  between.
- Once confirmed, the peak is **sticky** for the segment. A later artifact cannot
  move it or take it back.

A renewed rise creates a new maximum, which restarts the confirmation clock — so a
starter that pauses and climbs again is not called early.

Every threshold above is configuration, not a constant in the code.

## Segments

A feeding starts a new segment. Everything — the baseline, the arming, the peak —
is scoped to the readings since the last feeding, which is why logging the feeding
matters more than it looks.

## Guarding the baseline

The baseline is the reference the whole segment is measured against, so anchoring
it to a bad reading poisons everything downstream.

The failure is easy to hit: press "fed now" while the lid is still off, the sensor
looks past the jar at the table 363 mm away, and the baseline is set to that. Every
later height is nonsense — and worse, the handling cleanup then *keeps* the bogus
readings, because they match the baseline.

So a candidate baseline is rejected when it is deeper than any sourdough jar
(over 300 mm), when the readings it comes from are still swinging (spread over
10 mm), or when it is more than 150 mm farther away than the level was before the
feeding. The caller gets an explanation rather than a silently broken session.

## Timing, in practice

On a recorded session the detector reported the peak about 38 minutes after the
true maximum. That lag is the price of the confirmation window and the required
drop — both configurable, and both there to make the answer trustworthy rather than
quick. For a bake, being told half an hour after the top of a two-hour plateau is
fine; being told at 3 a.m. that a lid-off artifact was a peak is not.

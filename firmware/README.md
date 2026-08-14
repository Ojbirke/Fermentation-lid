# Firmware

Arduino sketch for the ESP32. Measures once a minute and uploads over WiFi.

## Building and flashing

1. Arduino IDE → Boards Manager → install **esp32** by Espressif.
2. Library Manager → install **VL53L1X** by Pololu.
3. Open [`fermentation_lid/fermentation_lid.ino`](fermentation_lid/fermentation_lid.ino).
4. Fill in the four values in the `CONFIGURATION` block at the top: WiFi name and
   password, your server's address, and the lid's token.
5. Select board **"ESP32 Dev Module"** and the right COM port, then Upload.

Open the Serial Monitor at **115200 baud**. A healthy start looks like this:

```
# wifi: ok, ip=192.168.1.42
# ntp: ok
min,mm
1.0,142
2.0,141
# sent 1 readings, buffered=0
```

## What it does

- **Median of 7 readings** per measurement, taken 30 ms apart. Raw noise is around
  ±3 mm and a median also discards the occasional wild single reading.
- **Timestamps on the device** via NTP, so the server gets a real time series even
  if uploads are delayed. NTP has to succeed once; the clock keeps running after
  that.
- **Buffers up to 240 readings** (4 hours) in RAM when the network is unavailable
  and sends them when it comes back. Re-sending is safe because the server ignores
  duplicates.
- **Recovers from a wedged sensor** in escalating steps. Three failed windows in
  a row trigger an I2C bus recovery (clocking out a slave that is holding SDA
  low); ten trigger a board restart, after flushing the buffer. Invalid readings
  are still recorded and sent throughout, so the server can tell the difference
  between "the lid is blind" and "the lid is gone".
- **Prints CSV to Serial** regardless, so you can log without a server at all.

## Notes

- `-1` in the output means no valid reading. An occasional one is normal; a steady
  stream of them usually means a loose wire. If they persist, the board restarts
  itself after ten minutes rather than sitting there blind.
- WiFi credentials are compiled in. That is fine for a device on your own bench;
  provisioning over BLE or a captive portal would be the next step for something
  you hand to someone else. Do not commit real credentials.
- `POST_EVERY = 1` uploads every reading, which is convenient while developing.
  Raise it to batch uploads and save power.
- There is no deep sleep yet, so this is a mains/USB-powered design for now.

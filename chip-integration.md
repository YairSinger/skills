# chip-integration skill

Run this skill before writing any driver or protocol code for a new chip or peripheral. It finds the ground-truth initialization sequence so you don't discover missing steps through hardware debugging.

## When to invoke

- Integrating a new IC for the first time (NFC reader, IMU, display, radio, etc.)
- Porting a driver to a new MCU/framework combination
- Hitting unexplained hardware behaviour that "should work" based on the datasheet alone

## Steps

### 1. Identify the exact part and platform

Confirm:
- Chip name and variant (e.g. PN532, not just "NFC reader")
- MCU and framework (e.g. ESP32-S3 + ESP-IDF v5.3)
- Communication bus (SPI / I2C / UART / etc.)

### 2. Search for reference implementations

Web-search for at least two of the following:
- `<chip> <framework> driver site:github.com`
- `<chip> <bus> initialization sequence`
- `<chip> datasheet <bus> mode`

Priority sources (highest to lowest trust):
1. Chip manufacturer's own SDK or application note
2. Widely-forked open-source libraries (Adafruit, SparkFun, libnfc, Arduino ecosystem)
3. Community forum posts with confirmed working code

### 3. Extract the mandatory initialization sequence

From the reference, identify every command sent before normal operation begins. Common things that are easy to miss:

| What to check | Why it matters |
|---|---|
| Power-on / wakeup sequence | Some chips need a specific pin toggle or CS pulse before accepting SPI |
| Mode configuration command | e.g. PN532 requires `SAMConfiguration(NormalMode)` or RF stays inactive |
| Bus polarity / bit order | e.g. PN532 SPI is LSB-first; ESP-IDF hardware SPI is MSB-first — requires bit-bang |
| Clock speed limits | Many chips have a max SPI frequency for bringup |
| Required delays | Oscillator startup time, reset-to-ready timing |
| Interrupt vs polling mode | Some chips behave differently depending on IRQ configuration |

### 4. Cross-check against the datasheet

Confirm the reference matches the datasheet for:
- Register/command values
- Timing requirements (setup/hold, wakeup delay)
- Default power-on state vs. required configured state

### 5. Document findings before writing code

Add a comment block or update `docs/hardware.md` with:
- The confirmed bus mode and bit order
- The mandatory init sequence (commands in order)
- Any platform-specific workarounds discovered

### 6. Implement init sequence first, verify, then add features

Flash only the init + a "ping" command (e.g. GetFirmwareVersion) before adding any application logic. Confirm the chip responds correctly before proceeding.

## Known findings for this project

| Chip | Bus | Key findings |
|---|---|---|
| PN532 | SPI | LSB-first — ESP-IDF hardware SPI is MSB-first, use bit-bang. Wakeup: CS low ≥10ms before first command. Init order: `SAMConfiguration(NormalMode)` → `RFConfiguration(MaxRetries)` → scan commands. Without SAMConfig the RF field stays inactive. |

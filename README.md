# Scare Mode (PC-free)

Four web pages, no PC. Every device opens the same site with the same **room code** (one per machine, e.g. `table3`).

| Device | Page | What it does |
|---|---|---|
| Backbox phone/iPod facing the player | `face.html?room=table3` | Streams the front camera and reads the Polar Verity Sense over Bluetooth |
| Phone/iPod over the playfield | `field.html?room=table3` | Streams the back camera |
| Your own phone | `control.html?room=table3` | Start/end games, player names, up next, prizes, CSV export |
| OptiSigns player on the TV | `display.html?room=table3` | The big screen: both cameras, live heartbeat, Most Scared / Ice Cold boards |

`index.html` is a picker that builds these links for you.

## Night-of setup
1. **TV:** in OptiSigns add a *Web Page* app with `https://<your-site>/display.html?room=table3`.
2. **Playfield phone:** open `field.html`, allow the camera, point it at the flippers.
3. **Face phone:** open `face.html`, allow the camera, tap **Connect armband**, pick the Verity Sense.
   - Android: use Chrome.
   - iPhone / iPod touch: Safari can't do Bluetooth, so open the page in the free **Bluefy** browser from the App Store. (The playfield phone is fine in plain Safari.)
4. **Your phone:** open `control.html`. All four status pills should go green. Type a name + initials, **Start game**, then **End game & save** when they drain.

## Tips
- Set phones to **Auto-Lock: Never** and plug them in. On iOS, Guided Access stops anyone leaving the page. The pages also try to keep the screen awake and restart the camera if iOS stops it.
- Put the Verity Sense in heart-rate (not recording) mode and keep it close to the face phone.
- Scores: each game records peak, low and average BPM. Most Scared = highest peak; Ice Cold = lowest peak.
- A "scare" flash fires when heart rate jumps 15+ BPM within 12 seconds.
- Games are saved on the TV page and backed up on the control phone; if the TV is wiped the control phone restores them. Use **Download CSV** at the end of the night.
- **Demo heartbeat** on the face page and **Test scare flash** on control let you test without a band.
- Needs internet at the venue only to introduce the devices to each other (free PeerJS service); video then goes directly between devices on your Wi-Fi.

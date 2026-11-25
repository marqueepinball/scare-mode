# Scare Mode (PC-free)

Five web pages, no PC. Every device opens the same site with the same **room code** (one per machine, e.g. `table3`).

| Device | Page | What it does |
|---|---|---|
| Backbox phone/iPod facing the player | `face.html?room=table3` | Streams the front camera and reads the Polar Verity Sense over Bluetooth |
| Phone/iPod over the playfield | `field.html?room=table3` | Streams the back camera |
| Phone/iPod aimed at the backbox score display (optional) | `score.html?room=table3` | Reads the score off the DMD/LCD on the phone itself and sends only the number (plus mode call-outs) to the TV. No video leaves the phone |
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

## Score cam (optional)
Plain Safari on iPhone is fine (no Bluetooth needed). Mount it so the score display fills a good part of the picture, square-on if you can, and avoid glare.
1. **Corners:** drag the four green corners onto the display's corners (for a dot matrix, onto the centre of each corner dot; a zoom bubble appears while dragging). Pick the display type.
2. **Score box:** on the straightened display, drag a box around just the score digits with a little room around them. For LCDs with busy backgrounds, choose *Match a colour* and tap a digit.
3. **Teach:** when a score is on screen, tap **Freeze**, type the number, tap **Learn**. Repeat until all ten digit chips are green. Teach a short score and a long one (many games switch to a smaller font as scores grow). If it shows **Unsure** on a score that is clearly visible, freeze and teach that one too.
4. **Modes (optional):** freeze on a screen like MULTIBALL, name it, tap **Capture**. The TV flashes the name and logs it when that screen appears again.

How it decides: each digit is matched against the examples you taught; frames where any digit is unclear (animations, mode screens, glare) are skipped, a new value must repeat on two frames, and the score never goes down mid-game unless a lower value persists for 3 seconds. The control page can correct a score by hand, and the score and modes go into the CSV. The setup is saved per room on that phone and can be downloaded to reuse on another phone. Accuracy depends on mounting and lighting; untested on a real machine so far.

## Tips
- Set phones to **Auto-Lock: Never** and plug them in. On iOS, Guided Access stops anyone leaving the page. The pages also try to keep the screen awake and restart the camera if iOS stops it.
- Put the Verity Sense in heart-rate (not recording) mode and keep it close to the face phone.
- Scores: each game records peak, low and average BPM. Most Scared = highest peak; Ice Cold = lowest peak.
- A "scare" flash fires when heart rate jumps 15+ BPM within 12 seconds.
- Games are saved on the TV page and backed up on the control phone; if the TV is wiped the control phone restores them. Use **Download CSV** at the end of the night.
- **Demo heartbeat** on the face page and **Test scare flash** on control let you test without a band.
- Needs internet at the venue only to introduce the devices to each other (free PeerJS service); video then goes directly between devices on your Wi-Fi.

# Scrapyard Sentinels: AR co-op robot game

A browser AR game for Meta Quest and Android phones. Each player scans the room,
a robot is placed on the real floor, and the players drive their robots to hold
off waves of enemies. Real furniture blocks movement and shots, and hides robots
that drive behind it. One or two players; a Quest and a phone can play together.

No app install. It is a web page plus a small Node server that pairs two players.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 16 unit tests (game rules, calibration maths, server relay)
```

WebXR needs HTTPS, so to play on a headset or phone, deploy it:

**Render**: push this folder to a GitHub repo, then New > Blueprint and pick the
repo (`render.yaml` is included), or New > Web Service with build `npm install`
and start `npm start`. Open the `https://…onrender.com` address in the Meta Quest
Browser or in Chrome on an ARCore Android phone. The free plan sleeps when idle,
so the first load after a break takes up to a minute.

On a computer the same page runs as an on-screen preview (drag to look, WASD to
move, Space to fire, E for EMP, Enter to confirm). Add `?preview` to force it.

## How a session goes

| Step | Solo | Co-op |
|---|---|---|
| 1 | Aim at the floor, place the arena | Both players mark the same two floor spots, A then B |
| 2 | Sweep the device around to scan | The game checks both players measured the same A to B distance |
| 3 | Start | Both see the A/B posts and a marker on their partner, and confirm |
| 4 | | Both scan, both press done, the game starts |

**Co-op calibration.** Put two small objects on the floor about a metre apart
(a coin and a key work). Each player marks the first object, then the second.
On Quest, touching the controller to the spot is the most accurate; pointing
also works. On a phone, aim the ring at the spot.

The game will not start until three things hold: each player's two marks are
on the same floor and at least 40 cm apart, both players measured the same
distance between A and B (within 6 cm or 6%), and both players pressed
"Looks aligned" after checking the posts and the partner marker. Either player
can redo their marks at any point before the game starts.

## Controls

| | Move | Fire | EMP blast | Confirm / back |
|---|---|---|---|---|
| Android phone | On-screen stick | FIRE button (auto-aims) | EMP button | On-screen buttons |
| Quest controllers | Thumbstick | Trigger (auto-aims) | Grip or A/X | Trigger / grip |
| Quest hands | Pinch and hold at a floor spot (moves and fires) | | | Pinch |

The stick is relative to where you are looking: up moves the robot away from you.
A downed robot comes back when its partner clears the wave.

## How it works

- `public/js/main.js` runs the WebXR session, the phases (place, calibrate, verify, scan, play) and the loop.
- `public/js/calib.js` turns the two floor marks into a shared coordinate frame. Every device already agrees on "up", so two floor points pin down the rest.
- `public/js/grid.js` is a 10 cm occupancy grid of the play area built from the scan, used for collision, line of sight and enemy pathfinding.
- `public/js/sim.js` is the game itself. The host's browser runs it; the guest predicts its own robot and interpolates the rest from 15 snapshots a second.
- `server.js` serves the files and relays messages between the two players in a room. It holds no game state.

**Scanning** uses whatever the device offers:

| Source | Quest 3 / 3S | Android Chrome |
|---|---|---|
| Hit-test rays fanned out from the view (floor and objects) | Yes | Yes |
| Detected planes and room mesh | Yes, from the headset's room setup | Only where the browser has plane detection enabled |
| Anchor to keep the arena pinned to the floor | Yes | Yes |

On Quest, if no room has been set up, the scan screen offers "Room setup" on
the grip button. On a phone, sweep slowly; flat surfaces register fastest.

## Notes and limits

- Both co-op players must be in the same physical room.
- Tested here with unit tests, a desktop browser, and Meta's Immersive Web Emulation Runtime (an emulated Quest 3 in scanned rooms, including a Quest host with a phone-style guest). It has not yet been run on physical hardware, so expect some tuning on first real use, most likely scan sensitivity (`HITS_NEEDED`, `MIN_H` in `grid.js`).
- `?hud=dom` forces the phone-style UI inside any WebXR session, which is handy in an emulator.
- Tuning values (robot speed, enemy stats, wave sizes) are at the top of `sim.js`.

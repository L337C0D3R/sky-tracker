# SkyTracker AR

Point your phone at the sky and get guided to planets, stars, satellites and asteroids using their live positions.

**Live:** https://space.teamleetcoders.in

## Features
- **AR camera mode**: the back camera with sky labels on top, driven by the phone's compass, gyro and accelerometer. Pick a target and arrows tell you which way to turn and tilt. The phone vibrates when the target is centred.
- **Sky map mode** for desktop or phones without motion sensors: drag, pinch or scroll to look around.
- **Planets, Sun, Moon and Pluto** from [Astronomy Engine](https://github.com/cosinekitty/astronomy) (VSOP87/ELP, about ±1″), with rise and set times.
- **Asteroids** (Ceres, Vesta, Pallas, Apophis, Bennu, Eros…) propagated from *today's* osculating elements from NASA/JPL Horizons, with light-time and parallax corrections. Checked against Horizons to within about 0.005°.
- **Satellites**: ISS, Tiangong, the brightest satellites, weather, GNSS and Starlink. Positions come from SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) using CelesTrak TLEs, with sunlit/shadow state and next-pass prediction.
- **5,000 stars** to magnitude 6 with distances in light-years (Hipparcos, via d3-celestial and the [HYG database](https://github.com/astronexus/HYG-Database), CC BY-SA 4.0), plus constellation figures.
- **Distance from you** for everything: km for satellites and the Moon, millions of km/AU plus light-travel time for planets and asteroids, light-years for stars.
- **Compass calibration**: point at the Moon or a bright planet and tap *Align* to remove magnetic and sensor error.
- Works offline once loaded (service worker).

## Architecture
Static site in `public/` plus Cloudflare Pages Functions in `functions/api/`:

| Endpoint | Purpose |
|---|---|
| `/api/tle?group=stations` | CelesTrak TLE proxy (adds CORS), edge-cached 2 h |
| `/api/asteroids` | JPL Horizons osculating elements for today, edge-cached 12 h |
| `/api/whereami` | Approximate location from Cloudflare's IP geolocation, used until GPS responds |

## Develop
```sh
npm install
npm run dev            # wrangler pages dev public → http://localhost:8788
npm run data           # rebuild star/constellation/asteroid data
```
Camera and sensors need HTTPS (or localhost).

## Deploy
Deploy manually with `npm run deploy` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). The repository already has those two secrets for a GitHub Actions deploy workflow.

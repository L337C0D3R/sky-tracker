# SkyTracker AR

Point your phone at the sky and get guided to planets, stars, satellites and asteroids using their live positions.

**Live:** https://space.teamleetcoders.in

## Features
- **AR camera mode**: the back camera with sky labels on top, driven by the phone's compass, gyro and accelerometer. Pick a target and arrows tell you which way to turn and tilt. The phone vibrates when the target is centred.
- **Night camera**: Auto, Night sky and Max boost presets. Where the browser allows it (Android Chrome), you also get shutter speed, ISO, exposure compensation, frame rate, focus locked at infinity and white balance. A software boost (gain, contrast and frame stacking for noise reduction) works on every phone, including iPhone.
- **Nearest 10 mode**: one tap hides everything except the horizon and the 10 closest satellites. They are ranked by live distance with paths, edge arrows for any off-screen, and a live list showing distance and whether each is approaching or receding.
- **Track mode**: lock onto one object and see its whole visit to your sky (a satellite's full pass, or a planet/star/Moon's rise→set arc) with clock times, highest point, rise/set, live countdowns, and a mini sky map that always shows the full path and what your camera sees (heading-up in camera mode). In sky-map mode, Fit path and Follow. Rise/set/peak verified against Skyfield (≤ 2 s, ≤ 0.003°).
- **Sunlight / shadow on satellite paths**: solid where the satellite is in sunlight (visible), dotted where it is in Earth's shadow, with the exact entry/exit time marked (verified against Skyfield: 100% agreement, edges within 0.16 s).
- **Trajectories**: hover an object with the mouse, or point the crosshair at it, to see its path across your sky. Satellites show the last 5 min and the next 10 min with minute marks; planets, the Sun, the Moon, stars and asteroids show their daily arc with hour marks and rise/set times.
- **Details for anything you tap**: live position and distance; for satellites, owner, launch date and site, orbit and the next passes with visibility; for planets, rise/transit/set, constellation, apparent size and moon phases; for stars, spectral type, temperature and luminosity. Wikipedia summaries are included where available.
- **Built for iPhone too**:
  - correct compass handling (`webkitCompassHeading`, with an accuracy readout and a calibration hint) and the iOS motion-permission flow
  - the plain 1× lens instead of Safari's lens-switching Triple/Dual camera, plus a lens picker (Ultra Wide / Wide / Telephoto) with per-lens field of view
  - automatic camera and screen wake-lock recovery after switching apps
  - haptic feedback on target lock (iOS 18)
  - home-screen app support (icons, full screen, safe areas, install hint)
  - the iOS share sheet with deep links (`?t=25544`), and "Add to Calendar" for satellite passes with a 10-minute alert
  - red night-vision mode
- **True north**: compass readings are corrected for magnetic declination using the World Magnetic Model 2025 (bundled from the MIT-licensed `geomagnetism` package).
- **Android-ready**:
  - Chrome absolute orientation, corrected to true north
  - the main lens chosen by default, with a lens picker
  - full-screen camera view and an "Install app" prompt
  - Google Calendar for satellite passes, vibration on target lock
  - automatic lower-quality mode on slower phones
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
| `/api/satcat?id=25544` | CelesTrak SATCAT record (owner, launch, size), edge-cached 1 day |
| (all of the above) | Two-level cache: edge cache + a global KV copy; served from backup if CelesTrak/JPL fail or rate-limit |
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

## Satellite data refresher
`refresher/` is a small scheduled Cloudflare Worker (cron `17 */2 * * *`) that downloads each satellite group from CelesTrak once every 2 hours and stores it in the `sky-tracker-cache` KV namespace that the site's `/api/tle` reads. Visitors are served from KV, and CelesTrak receives one request per group per 2 hours, as its usage policy asks. Deploy it with `cd refresher && npx wrangler deploy`.

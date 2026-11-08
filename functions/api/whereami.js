// GET /api/whereami -> approximate location from Cloudflare's IP geolocation,
// used only until the browser's GPS location arrives.
export function onRequestGet({ request }) {
  const cf = request.cf || {};
  return Response.json(
    { lat: cf.latitude ? +cf.latitude : null, lon: cf.longitude ? +cf.longitude : null, city: cf.city || null },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}

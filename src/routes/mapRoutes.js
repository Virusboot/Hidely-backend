const express = require('express');
const router = express.Router();
const https = require('https');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCNU24xs5Ky9uQ3pHfhyv9ofkjUd_o5_yI';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// 1. Geocode Proxy (With Photon Fallback)
router.get('/geocode', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) {
      return res.status(400).json({ error: 'Address parameter is required' });
    }

    // Try Google Maps first
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
      const result = await fetchJson(url);
      if (result.statusCode === 200 && result.body && result.body.status === 'OK' && result.body.results && result.body.results.length > 0) {
        return res.status(200).json(result.body);
      }
    } catch (gErr) {
      console.warn('[MapProxy] Google Geocode failed, using Photon fallback:', gErr.message);
    }

    // Fallback: Photon Geocoder (Free OpenStreetMap based)
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1&lang=en`;
    const photonRes = await fetchJson(photonUrl);
    if (photonRes.body && photonRes.body.features && photonRes.body.features.length > 0) {
      const f = photonRes.body.features[0];
      const lng = f.geometry.coordinates[0];
      const lat = f.geometry.coordinates[1];
      const p = f.properties || {};
      const formattedAddress = [p.name, p.street, p.city, p.county, p.state, p.country].filter(Boolean).join(', ');

      return res.status(200).json({
        status: 'OK',
        results: [{
          formatted_address: formattedAddress || address,
          geometry: {
            location: { lat, lng }
          }
        }]
      });
    }

    res.status(200).json({ status: 'ZERO_RESULTS', results: [] });
  } catch (error) {
    console.error('[MapProxy] Geocode error:', error);
    res.status(500).json({ error: 'Failed to geocode address' });
  }
});

// 2. Nearby Places Proxy
router.get('/places/nearby', async (req, res) => {
  try {
    const { location, radius = 1000, type = 'tourist_attraction' } = req.query;
    if (!location) {
      return res.status(400).json({ error: 'Location parameter (lat,lng) is required' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${encodeURIComponent(location)}&radius=${radius}&type=${encodeURIComponent(type)}&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Places nearby error:', error);
    res.status(500).json({ error: 'Failed to fetch nearby places' });
  }
});

// 3. Text Search Places Proxy
router.get('/places/textsearch', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Places textsearch error:', error);
    res.status(500).json({ error: 'Failed to search places' });
  }
});

// 4. Directions Proxy
router.get('/directions', async (req, res) => {
  try {
    const { origin, destination, mode = 'driving', language = 'en', alternatives = 'true' } = req.query;
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination parameters are required' });
    }
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}&language=${language}&alternatives=${alternatives}&key=${GOOGLE_MAPS_API_KEY}`;
    if (mode === 'driving') {
      url += '&departure_time=now&traffic_model=best_guess';
    }
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Directions error:', error);
    res.status(500).json({ error: 'Failed to get directions' });
  }
});

// 5. Autocomplete Proxy (With Photon Fallback)
router.get('/autocomplete', async (req, res) => {
  try {
    const { input } = req.query;
    if (!input) {
      return res.status(400).json({ error: 'Input parameter is required' });
    }

    // Try Google Maps first
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:in&key=${GOOGLE_MAPS_API_KEY}`;
      const result = await fetchJson(url);
      if (result.statusCode === 200 && result.body && result.body.status === 'OK' && result.body.predictions && result.body.predictions.length > 0) {
        return res.status(200).json(result.body);
      }
    } catch (gErr) {
      console.warn('[MapProxy] Google Autocomplete failed, using Photon fallback:', gErr.message);
    }

    // Fallback: Photon Autocomplete (Free OpenStreetMap based, no key required)
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(input)}&limit=8&lang=en`;
    const photonRes = await fetchJson(photonUrl);
    if (photonRes.body && photonRes.body.features && photonRes.body.features.length > 0) {
      const predictions = photonRes.body.features.map((f) => {
        const p = f.properties || {};
        const coords = f.geometry ? f.geometry.coordinates : [0, 0];
        const lng = coords[0];
        const lat = coords[1];

        const name = p.name || '';
        const street = p.street || '';
        const city = p.city || p.county || '';
        const state = p.state || '';
        const country = p.country || '';

        const parts = [name, street, city, state, country].filter(Boolean);
        const uniqueParts = [...new Set(parts)];
        const description = uniqueParts.join(', ');
        const mainText = name || uniqueParts[0] || 'Location';
        const secondaryText = uniqueParts.slice(1).join(', ') || country;

        return {
          description,
          place_id: `photon_${lat}_${lng}`,
          structured_formatting: {
            main_text: mainText,
            secondary_text: secondaryText,
          },
        };
      });

      return res.status(200).json({
        status: 'OK',
        predictions,
      });
    }

    res.status(200).json({ status: 'ZERO_RESULTS', predictions: [] });
  } catch (error) {
    console.error('[MapProxy] Autocomplete error:', error);
    res.status(500).json({ error: 'Failed to autocomplete places' });
  }
});

// 6. Place Details Proxy (With Photon Fallback)
router.get('/details', async (req, res) => {
  try {
    const { place_id, fields = 'geometry' } = req.query;
    if (!place_id) {
      return res.status(400).json({ error: 'place_id parameter is required' });
    }

    // Instant resolution if place_id is generated by Photon
    if (place_id.startsWith('photon_')) {
      const parts = place_id.split('_');
      if (parts.length >= 3) {
        const lat = parseFloat(parts[1]);
        const lng = parseFloat(parts[2]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return res.status(200).json({
            status: 'OK',
            result: {
              geometry: {
                location: { lat, lng }
              }
            }
          });
        }
      }
    }

    // Try Google Maps
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=${encodeURIComponent(fields)}&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Place details error:', error);
    res.status(500).json({ error: 'Failed to get place details' });
  }
});

module.exports = router;

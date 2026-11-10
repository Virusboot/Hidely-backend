const express = require('express');
const router = express.Router();
const https = require('https');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCNU24xs5Ky9uQ3pHfhyv9ofkjUd_o5_yI';

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'HidelyTravelApp/1.0 (https://hidely.app)',
        'Accept': 'application/json',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.setTimeout(8000, () => {
      req.destroy(new Error('Upstream request timeout'));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function isValidCoordPair(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)
  );
}

function isPlusCodeLike(text) {
  if (!text) return false;
  return /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,4}$/i.test(text.trim());
}

function formatPlaceDisplayName({ landmark, city, state, country, formattedAddress }) {
  const parts = [];
  const addUnique = (val) => {
    const clean = (val || '').trim();
    if (!clean || isPlusCodeLike(clean)) return;
    if (!parts.some((p) => p.toLowerCase() === clean.toLowerCase() || p.toLowerCase().includes(clean.toLowerCase()))) {
      parts.push(clean);
    }
  };

  addUnique(landmark);
  addUnique(city);
  if (parts.length < 2) addUnique(state);
  if (parts.length === 0) addUnique(country);

  if (parts.length >= 2) {
    return `${parts[0]}, ${parts[1]}`;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (formattedAddress) {
    const fallbackParts = formattedAddress
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !isPlusCodeLike(s) && !/^\d{5,6}$/.test(s));
    if (fallbackParts.length >= 2) {
      return `${fallbackParts[0]}, ${fallbackParts[1]}`;
    }
    if (fallbackParts.length === 1) {
      return fallbackParts[0];
    }
  }
  return '';
}

function parseGoogleReverseResults(results, lat, lng) {
  if (!Array.isArray(results) || results.length === 0) return null;

  let landmark = '';
  let landmarkType = '';
  let sublocality = '';
  let route = '';
  let city = '';
  let state = '';
  let country = '';

  const priorityTypes = [
    'tourist_attraction',
    'natural_feature',
    'park',
    'point_of_interest',
    'establishment',
    'premise',
    'sublocality_level_2',
    'sublocality_level_1',
    'neighborhood',
    'sublocality',
  ];

  for (const res of results) {
    const components = Array.isArray(res.address_components) ? res.address_components : [];
    for (const comp of components) {
      const types = Array.isArray(comp.types) ? comp.types : [];
      const name = comp.long_name || '';
      if (!name || isPlusCodeLike(name)) continue;

      if (!landmark) {
        const matchedPriority = priorityTypes.find((t) => types.includes(t));
        if (matchedPriority && !matchedPriority.startsWith('sublocality')) {
          landmark = name;
          landmarkType = matchedPriority;
        }
      }
      if (!sublocality && (types.includes('sublocality_level_1') || types.includes('sublocality_level_2') || types.includes('neighborhood') || types.includes('sublocality'))) {
        sublocality = name;
      }
      if (!route && types.includes('route')) {
        route = name;
      }
      if (!city && (types.includes('locality') || types.includes('postal_town'))) {
        city = name;
      }
      if (!city && types.includes('administrative_area_level_2')) {
        city = name;
      }
      if (!state && types.includes('administrative_area_level_1')) {
        state = name;
      }
      if (!country && types.includes('country')) {
        country = name;
      }
    }
  }

  const chosenLandmark = landmark || sublocality || route || '';
  const formattedAddress = results[0].formatted_address || '';
  const displayName = formatPlaceDisplayName({
    landmark: chosenLandmark,
    city,
    state,
    country,
    formattedAddress,
  });

  if (!displayName) return null;

  return {
    status: 'OK',
    display_name: displayName,
    formatted_address: formattedAddress || displayName,
    landmark: chosenLandmark || city || state,
    city,
    state,
    country,
    landmark_type: landmarkType || (sublocality ? 'neighborhood' : 'locality'),
    latitude: lat,
    longitude: lng,
  };
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
    const { input, lat, lng } = req.query;
    if (!input) {
      return res.status(400).json({ error: 'Input parameter is required' });
    }

    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    const hasBias = isValidCoordPair(parsedLat, parsedLng);

    // Try Google Maps first
    try {
      const biasParam = hasBias ? `&location=${parsedLat},${parsedLng}&radius=50000` : '';
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}${biasParam}&key=${GOOGLE_MAPS_API_KEY}`;
      const result = await fetchJson(url);
      if (result.statusCode === 200 && result.body && result.body.status === 'OK' && result.body.predictions && result.body.predictions.length > 0) {
        return res.status(200).json(result.body);
      }
    } catch (gErr) {
      console.warn('[MapProxy] Google Autocomplete failed, using Photon fallback:', gErr.message);
    }

    // Fallback: Photon Autocomplete (Free OpenStreetMap based, no key required)
    const photonBias = hasBias ? `&lat=${parsedLat}&lon=${parsedLng}` : '';
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(input)}&limit=8&lang=en${photonBias}`;
    const photonRes = await fetchJson(photonUrl);
    if (photonRes.body && photonRes.body.features && photonRes.body.features.length > 0) {
      const predictions = photonRes.body.features.map((f) => {
        const p = f.properties || {};
        const coords = f.geometry ? f.geometry.coordinates : [0, 0];
        const fLng = coords[0];
        const fLat = coords[1];

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
          place_id: `photon_${fLat}_${fLng}`,
          geometry: {
            location: { lat: fLat, lng: fLng },
          },
          city,
          state,
          country,
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
    const { place_id, fields = 'geometry,formatted_address,address_components,name' } = req.query;
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

// 7. Reverse Geocode Proxy (Google -> Nominatim -> Photon fallback)
router.get('/reverse-geocode', async (req, res) => {
  try {
    const rawLat = req.query.lat;
    const rawLng = req.query.lng !== undefined ? req.query.lng : req.query.lon;
    const lat = parseFloat(rawLat);
    const lng = parseFloat(rawLng);

    if (!isValidCoordPair(lat, lng)) {
      return res.status(400).json({ error: 'Valid lat and lng parameters are required' });
    }

    // 1. Google Maps Reverse Geocoding
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=en&key=${GOOGLE_MAPS_API_KEY}`;
      const result = await fetchJson(url);
      if (result.statusCode === 200 && result.body && result.body.status === 'OK') {
        const parsed = parseGoogleReverseResults(result.body.results, lat, lng);
        if (parsed) {
          return res.status(200).json(parsed);
        }
      }
    } catch (gErr) {
      console.warn('[MapProxy] Google Reverse Geocode failed:', gErr.message);
    }

    // 2. OpenStreetMap Nominatim (zoom=18 for pinpoint landmarks & localities)
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const nomRes = await fetchJson(nomUrl, { 'Accept-Language': 'en' });
      if (nomRes.statusCode === 200 && nomRes.body && nomRes.body.address) {
        const data = nomRes.body;
        const addr = data.address;
        const landmark =
          data.name ||
          addr.tourism ||
          addr.natural ||
          addr.attraction ||
          addr.historic ||
          addr.leisure ||
          addr.waterway ||
          addr.park ||
          addr.amenity ||
          addr.building ||
          addr.neighbourhood ||
          addr.quarter ||
          addr.suburb ||
          addr.city_district ||
          addr.road ||
          addr.hamlet ||
          '';
        const city =
          addr.city ||
          addr.town ||
          addr.village ||
          addr.municipality ||
          addr.county ||
          addr.state_district ||
          '';
        const state = addr.state || '';
        const country = addr.country || '';
        const displayName = formatPlaceDisplayName({
          landmark,
          city,
          state,
          country,
          formattedAddress: data.display_name || '',
        });
        if (displayName) {
          return res.status(200).json({
            status: 'OK',
            display_name: displayName,
            formatted_address: data.display_name || displayName,
            landmark: landmark || city || state,
            city,
            state,
            country,
            landmark_type: data.type || data.category || '',
            latitude: lat,
            longitude: lng,
          });
        }
      }
    } catch (nErr) {
      console.warn('[MapProxy] Nominatim Reverse Geocode failed:', nErr.message);
    }

    // 3. Photon Reverse Geocoding
    try {
      const photonUrl = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`;
      const photonRes = await fetchJson(photonUrl);
      if (photonRes.statusCode === 200 && photonRes.body && Array.isArray(photonRes.body.features) && photonRes.body.features.length > 0) {
        const p = photonRes.body.features[0].properties || {};
        const landmark = p.name || p.street || p.district || p.locality || '';
        const city = p.city || p.county || '';
        const state = p.state || '';
        const country = p.country || '';
        const displayName = formatPlaceDisplayName({ landmark, city, state, country });
        if (displayName) {
          return res.status(200).json({
            status: 'OK',
            display_name: displayName,
            formatted_address: [landmark, city, state, country].filter(Boolean).join(', '),
            landmark: landmark || city || state,
            city,
            state,
            country,
            landmark_type: p.osm_value || p.type || '',
            latitude: lat,
            longitude: lng,
          });
        }
      }
    } catch (pErr) {
      console.warn('[MapProxy] Photon Reverse Geocode failed:', pErr.message);
    }

    return res.status(200).json({ status: 'ZERO_RESULTS', results: [] });
  } catch (error) {
    console.error('[MapProxy] Reverse Geocode error:', error);
    return res.status(500).json({ error: 'Failed to reverse geocode coordinates' });
  }
});

module.exports = router;

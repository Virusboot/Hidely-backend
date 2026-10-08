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

// 1. Geocode Proxy
router.get('/geocode', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) {
      return res.status(400).json({ error: 'Address parameter is required' });
    }
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
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

// 5. Autocomplete Proxy
router.get('/autocomplete', async (req, res) => {
  try {
    const { input } = req.query;
    if (!input) {
      return res.status(400).json({ error: 'Input parameter is required' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:in&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Autocomplete error:', error);
    res.status(500).json({ error: 'Failed to autocomplete places' });
  }
});

// 6. Place Details Proxy
router.get('/details', async (req, res) => {
  try {
    const { place_id, fields = 'geometry' } = req.query;
    if (!place_id) {
      return res.status(400).json({ error: 'place_id parameter is required' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=${encodeURIComponent(fields)}&key=${GOOGLE_MAPS_API_KEY}`;
    const result = await fetchJson(url);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error('[MapProxy] Place details error:', error);
    res.status(500).json({ error: 'Failed to get place details' });
  }
});

module.exports = router;

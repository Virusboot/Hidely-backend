require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('../config/db');

async function run() {
  try {
    // 1. Fix misclassified posts
    await db.query("UPDATE posts SET category = 'Heritage' WHERE id = 27");
    console.log('Fixed post 27 to Heritage');

    // 2. Complete curated list for all travel categories
    const newPosts = [
      // --- RIVERS ---
      {
        user_id: 20,
        caption: 'Rishikesh Ganga Ghat: Pristine Emerald River Waters & Sacred Foothills 🌊',
        image_url: 'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?w=800',
        location: 'Triveni Ghat, Rishikesh, Uttarakhand',
        category: 'Rivers',
        likes_count: 245,
        city: 'Rishikesh',
        state: 'Uttarakhand',
        country: 'India',
        latitude: 30.1033,
        longitude: 78.2947
      },
      {
        user_id: 20,
        caption: 'Teesta River Gorge: Crystal Glacial River through Sikkim Valleys 🏔️',
        image_url: 'https://images.unsplash.com/photo-1544735716-392fe2489ffa?w=800',
        location: 'Teesta River Valley, Sikkim',
        category: 'Rivers',
        likes_count: 189,
        city: 'Mangan',
        state: 'Sikkim',
        country: 'India',
        latitude: 27.5020,
        longitude: 88.5270
      },

      // --- WATERFALLS ---
      {
        user_id: 20,
        caption: 'Dudhsagar Falls: Four-Tiered Milky Waterfalls in Western Ghats 🌊',
        image_url: 'https://images.unsplash.com/photo-1546776310-eef45dd6d63c?w=800',
        location: 'Dudhsagar Falls, Goa',
        category: 'Waterfalls',
        likes_count: 312,
        city: 'Sanguem',
        state: 'Goa',
        country: 'India',
        latitude: 15.3144,
        longitude: 74.3143
      },
      {
        user_id: 20,
        caption: 'Jog Falls: Untamed Thunderous Cataract of the Western Ghats 🌲',
        image_url: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?w=800',
        location: 'Jog Falls, Shimoga, Karnataka',
        category: 'Waterfalls',
        likes_count: 278,
        city: 'Shimoga',
        state: 'Karnataka',
        country: 'India',
        latitude: 14.2285,
        longitude: 74.8125
      },

      // --- TREKKING SPOTS ---
      {
        user_id: 20,
        caption: 'Triund Trek: Breathtaking Ridge Hike with Dhauladhar Panoramic Views 🥾',
        image_url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800',
        location: 'Triund, Dharamshala, Himachal Pradesh',
        category: 'Trekking Spots',
        likes_count: 388,
        city: 'Dharamshala',
        state: 'Himachal Pradesh',
        country: 'India',
        latitude: 32.2570,
        longitude: 76.3530
      },
      {
        user_id: 20,
        caption: 'Valley of Flowers: UNESCO Alpine Meadow Full of Wild Himalayan Flora 🌸',
        image_url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800',
        location: 'Valley of Flowers National Park, Chamoli, Uttarakhand',
        category: 'Trekking Spots',
        likes_count: 420,
        city: 'Joshimath',
        state: 'Uttarakhand',
        country: 'India',
        latitude: 30.7280,
        longitude: 79.6053
      },
      {
        user_id: 20,
        caption: 'Kheerganga Trek: High-Altitude Pine Trail to Natural Hot Springs ♨️',
        image_url: 'https://images.unsplash.com/photo-1486870591958-9b9d0d1dda99?w=800',
        location: 'Kheerganga, Parvati Valley, Himachal Pradesh',
        category: 'Trekking Spots',
        likes_count: 365,
        city: 'Kasol',
        state: 'Himachal Pradesh',
        country: 'India',
        latitude: 31.9890,
        longitude: 77.5110
      },

      // --- CAMPING SPOTS ---
      {
        user_id: 20,
        caption: 'Pawna Lake Camping: Starlit Waterside Camp & Bonfire Night ⛺',
        image_url: 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?w=800',
        location: 'Pawna Lake, Lonavala, Maharashtra',
        category: 'Camping Spots',
        likes_count: 310,
        city: 'Lonavala',
        state: 'Maharashtra',
        country: 'India',
        latitude: 18.6850,
        longitude: 73.4910
      },
      {
        user_id: 20,
        caption: 'Chopta Meadows: High-Altitude Stargazing Campsite & Bugyal Views 🏕️',
        image_url: 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=800',
        location: 'Chopta, Rudraprayag, Uttarakhand',
        category: 'Camping Spots',
        likes_count: 295,
        city: 'Rudraprayag',
        state: 'Uttarakhand',
        country: 'India',
        latitude: 30.4850,
        longitude: 79.1830
      },

      // --- LAKES ---
      {
        user_id: 24,
        caption: 'Naini Lake: Emerald Water Mirror Ringed by Kumaon Mountains 🛶',
        image_url: 'https://res.cloudinary.com/lxfbzehh/image/upload/v1791547096/hidely/posts/bqenz5vj8wlydhl3skxz.jpg',
        location: 'Naini Lake, Nainital, Uttarakhand',
        category: 'Lakes',
        likes_count: 142,
        city: 'Nainital',
        state: 'Uttarakhand',
        country: 'India',
        latitude: 29.3803,
        longitude: 79.4636
      },
      {
        user_id: 20,
        caption: 'Pangong Tso: Color-Shifting Blue Saline Lake of High Himalayas 🌊',
        image_url: 'https://images.unsplash.com/photo-1589182373726-e4f658ab50f0?w=800',
        location: 'Pangong Lake, Ladakh',
        category: 'Lakes',
        likes_count: 512,
        city: 'Leh',
        state: 'Ladakh',
        country: 'India',
        latitude: 33.7595,
        longitude: 78.6674
      },

      // --- BEACHES ---
      {
        user_id: 20,
        caption: 'Palolem Beach: Golden Crescent Bay with Swaying Palms 🏖️',
        image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800',
        location: 'Palolem Beach, Canacona, South Goa',
        category: 'Beaches',
        likes_count: 430,
        city: 'Canacona',
        state: 'Goa',
        country: 'India',
        latitude: 15.0100,
        longitude: 74.0232
      },
      {
        user_id: 20,
        caption: 'Radhanagar Beach: Turquoise Waters & Serene Andaman Sunset 🌴',
        image_url: 'https://images.unsplash.com/photo-1519046904884-53103b34b206?w=800',
        location: 'Radhanagar Beach, Havelock Island, Andaman',
        category: 'Beaches',
        likes_count: 480,
        city: 'Havelock',
        state: 'Andaman & Nicobar',
        country: 'India',
        latitude: 11.9840,
        longitude: 92.9510
      },

      // --- FORESTS ---
      {
        user_id: 20,
        caption: 'Mawlynnong Living Root Bridges: Ancient Bio-Engineered Rainforest 🌿',
        image_url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800',
        location: 'East Khasi Hills, Meghalaya',
        category: 'Forests',
        likes_count: 360,
        city: 'Shillong',
        state: 'Meghalaya',
        country: 'India',
        latitude: 25.2010,
        longitude: 91.8840
      }
    ];

    for (const post of newPosts) {
      const exists = await db.query('SELECT id FROM posts WHERE caption = $1', [post.caption]);
      if (exists.rows.length === 0) {
        await db.query(
          `INSERT INTO posts (user_id, caption, image_url, location, category, likes_count, city, state, country, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [post.user_id, post.caption, post.image_url, post.location, post.category, post.likes_count, post.city, post.state, post.country, post.latitude, post.longitude]
        );
        console.log(`Inserted: ${post.category} - ${post.caption}`);
      } else {
        console.log(`Already exists: ${post.caption}`);
      }
    }

    const checkCats = await db.query('SELECT category, count(*)::int as count FROM posts GROUP BY category ORDER BY count DESC');
    console.log('\nUpdated Post categories in DB:');
    checkCats.rows.forEach(r => console.log(`  - ${r.category}: ${r.count} posts`));

    process.exit(0);
  } catch (err) {
    console.error('Error seeding categories:', err);
    process.exit(1);
  }
}

run();

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const app = express();
app.use(cors());
app.use(express.json());

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage to accept file uploads
const upload = multer({ storage: multer.memoryStorage() });

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 4000;

const restaurantSchema = new mongoose.Schema({
  name: String,
  address: String,
  city: String,
  area: String,
  latitude: Number,
  longitude: Number,
  verified: { type: Boolean, default: false },
  satvikType: { type: String, enum: ['Pure Satvik', 'No Onion/Garlic', 'Jain Friendly'] },
  priceRange: { type: String, enum: ['$', '$$', '$$$'] },
  menu: [{ name: String, description: String, price: Number }],
  story: String,
  bestTimeToVisit: String,
});

const partnerSubmissionSchema = new mongoose.Schema({
  profile: { type: Object, required: true },
  menuItems: { type: Array, default: [] },
  offers: { type: Array, default: [] },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
})
const PartnerSubmission = mongoose.models.PartnerSubmission || mongoose.model('PartnerSubmission', partnerSubmissionSchema)
const inMemorySubmissions = []

const Restaurant = mongoose.models.Restaurant || mongoose.model('Restaurant', restaurantSchema);

async function connectMongo() {
  if (!MONGO_URI) {
    console.warn('No MONGO_URI provided. Server will run with in-memory sample data.');
    return;
  }
  try {
    await mongoose.connect(MONGO_URI, { dbName: process.env.DB_NAME || undefined });
    console.log('Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

// Haversine distance (km)
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const sampleData = [
  {
    _id: '1',
    name: 'Satvic Sagar',
    address: '12 Peace Lane, Old Town',
    city: 'Jaipur',
    area: 'Old Town',
    latitude: 26.9124,
    longitude: 75.7873,
    verified: true,
    satvikType: 'Pure Satvik',
    priceRange: '$$',
    menu: [
      { name: 'Khichdi', description: 'Simple, sattvic comfort food', price: 120 },
      { name: 'Fruit Bowl', description: 'Seasonal fresh fruits', price: 150 }
    ],
    story: 'Founded by spiritual seekers to serve clean food.',
    bestTimeToVisit: 'Evenings 6-8pm',
  },
  {
    _id: '2',
    name: 'Jain Bhojanalaya',
    address: '45 Harmony Street, City Center',
    city: 'Ahmedabad',
    area: 'City Center',
    latitude: 23.0225,
    longitude: 72.5714,
    verified: true,
    satvikType: 'Jain Friendly',
    priceRange: '$$',
    menu: [
      { name: 'Jain Thali', description: 'No onion/garlic, simple and pure', price: 200 },
      { name: 'Dal-Rice', description: 'Clean and nutritious', price: 150 }
    ],
    story: 'Serving Jain-friendly meals for decades.',
    bestTimeToVisit: 'Lunch 12-2pm',
  }
];

function getModel() {
  if (mongoose.connection.readyState === 1 && MONGO_URI) {
    return Restaurant;
  }
  // In-memory fallback using sample data
  return {
    async find(query = {}) {
      const verifiedOnly = query.verified === true;
      let results = sampleData.filter((r) => (verifiedOnly ? r.verified : true));
      if (query.city) {
        results = results.filter((r) => r.city.toLowerCase() === String(query.city).toLowerCase());
      }
      if (query.satvikType) {
        results = results.filter((r) => r.satvikType === query.satvikType);
      }
      return results;
    },
    async findById(id) {
      return sampleData.find((r) => r._id === id) || null;
    }
  };
}

app.get('/api/restaurants', async (req, res) => {
  try {
    const { city, satvikType, q } = req.query;
    const Model = getModel();
    let results = await Model.find({ verified: true, city, satvikType });

    if (q) {
      const ql = String(q).toLowerCase();
      results = results.filter((r) => r.name.toLowerCase().includes(ql) || r.area.toLowerCase().includes(ql));
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/restaurants/nearby', async (req, res) => {
  const { lat, lng } = req.query;
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  try {
    const Model = getModel();
    const all = await Model.find({ verified: true });
    const withDistance = all.map((r) => ({
      ...r,
      distanceKm: distanceKm(latitude, longitude, r.latitude, r.longitude),
    }));
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
    res.json(withDistance);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const Model = getModel();
    const restaurant = await Model.findById(req.params.id);
    if (!restaurant || restaurant.verified !== true) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(restaurant);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/', (req, res) => {
  res.send('Satvic API running');
});

// Cloudinary upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Upload buffer to Cloudinary using upload_stream
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'satvic/partner' }, (error, uploadResult) => {
        if (error) return reject(error);
        resolve(uploadResult);
      });
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });
    return res.status(200).json({ url: result.secure_url, public_id: result.public_id });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/partners', async (req, res) => {
  try {
    const { profile, menuItems, offers } = req.body || {}
    if (!profile?.name || !profile?.city || !profile?.phone || !Array.isArray(menuItems) || menuItems.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: name, city, phone, at least one menu item' })
    }

    // If Mongo connected, persist; otherwise, in-memory
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const doc = await PartnerSubmission.create({ profile, menuItems, offers, status: 'pending' })
      return res.status(201).json({ id: String(doc._id), status: doc.status })
    } else {
      const id = String(Date.now())
      inMemorySubmissions.push({ id, profile, menuItems, offers, status: 'pending', createdAt: new Date() })
      return res.status(201).json({ id, status: 'pending' })
    }
  } catch (e) {
    console.error('Partner submit error:', e.message)
    return res.status(500).json({ error: 'Server error' })
  }
})

app.get('/api/partners', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const list = await PartnerSubmission.find({}).sort({ createdAt: -1 }).lean()
      return res.json(list.map((d) => ({ id: String(d._id), profile: d.profile, menuItems: d.menuItems, offers: d.offers || [], status: d.status, createdAt: d.createdAt })))
    }
    res.json(inMemorySubmissions.map((s) => ({ id: s.id, profile: s.profile, menuItems: s.menuItems, offers: s.offers || [], status: s.status, createdAt: s.createdAt })))
  } catch (e) {
    console.error('Partners list error:', e.message)
    res.status(500).json({ error: 'Server error' })
  }
})

function buildAddress(profile) {
  const parts = [profile.street, profile.city, profile.state, profile.pincode].filter(Boolean)
  return parts.join(', ') || profile.city || ''
}

app.post('/api/partners/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    let submission
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      submission = await PartnerSubmission.findById(id).lean()
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
    } else {
      submission = inMemorySubmissions.find((s) => s.id === id)
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
    }
    const { profile, menuItems } = submission
    const RestaurantModel = mongoose.connection.readyState === 1 ? Restaurant : null
    const restaurantData = {
      name: profile.name || 'Restaurant',
      address: buildAddress(profile),
      city: profile.city || '',
      area: profile.area || profile.city || '',
      latitude: profile.latitude != null && profile.latitude !== '' ? Number(profile.latitude) : undefined,
      longitude: profile.longitude != null && profile.longitude !== '' ? Number(profile.longitude) : undefined,
      verified: true,
      satvikType: profile.vegStatus === 'Pure Satvik' ? 'Pure Satvik' : profile.jainFriendly ? 'Jain Friendly' : 'No Onion/Garlic',
      priceRange: '$$',
      menu: (menuItems || []).map((m) => ({ name: m.name || '', description: m.description || '', price: Number(m.price) || 0 })),
      story: profile.notes || '',
      bestTimeToVisit: profile.hours || '',
    }
    if (RestaurantModel) {
      const created = await RestaurantModel.create(restaurantData)
      try {
        await PartnerSubmission.updateOne({ _id: submission._id }, { status: 'approved' })
      } catch (upErr) {
        console.warn('Update submission status:', upErr.message)
      }
      return res.json({ id: String(created._id), status: 'approved', restaurantId: String(created._id) })
    }
    sampleData.push({ ...restaurantData, _id: String(sampleData.length + 1) })
    const inMem = inMemorySubmissions.find((s) => s.id === id)
    if (inMem) inMem.status = 'approved'
    res.json({ id: submission.id, status: 'approved', restaurantId: String(sampleData.length) })
  } catch (e) {
    console.error('Approve error:', e.message)
    res.status(500).json({ error: 'Server error' })
  }
})

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
  });
});
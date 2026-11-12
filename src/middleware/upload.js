const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function createStorage(prefixOverride = null) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path
        .extname(file.originalname || '')
        .toLowerCase()
        .replace(/[^a-z0-9.]/g, '');
      const prefix = prefixOverride || file.fieldname || 'media';
      cb(null, `${prefix}-${uniqueSuffix}${ext}`);
    },
  });
}

// Strict file type filter (requires safe extension AND safe/known image/video MIME)
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/jpg',
    'image/webp',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/quicktime',
    'video/x-matroska',
    'video/x-msvideo',
    'video/avi',
    'video/mpeg',
  ];
  const ext = path.extname(file.originalname || '').toLowerCase();
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4', '.mov', '.avi', '.mkv', '.mpeg'];
  const mimeLower = (file.mimetype || '').toLowerCase().split(';')[0].trim();

  const extAllowed = allowedExtensions.includes(ext);
  const mimeAllowed =
    allowedMimeTypes.includes(mimeLower) ||
    mimeLower === 'application/octet-stream' ||
    mimeLower === 'binary/octet-stream';

  if (extAllowed && mimeAllowed) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only standard images and videos are allowed!'), false);
  }
};

// Default multer config
const upload = multer({
  storage: createStorage(),
  fileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB limit
  },
});

const chatMedia = multer({
  storage: createStorage('chat'),
  fileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB limit
  },
});

upload.chatMedia = chatMedia;
upload.fileFilter = fileFilter;

module.exports = upload;

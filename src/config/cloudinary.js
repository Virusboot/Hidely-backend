const cloudinary = require('cloudinary').v2;
const fs = require('fs');
require('dotenv').config();

// Configure Cloudinary credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const path = require('path');

/**
 * Uploads a local file to Cloudinary and unlinks the local file.
 * Falls back to local storage if Cloudinary upload fails.
 * @param {string} localFilePath - Path to the local file saved by Multer
 * @param {string} folder - Cloudinary folder/category
 * @returns {Promise<string>} - Secure URL of the uploaded asset
 */
const uploadToCloudinary = async (localFilePath, folder = 'hidely') => {
  try {
    if (!localFilePath) return null;

    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      const response = await cloudinary.uploader.upload(localFilePath, {
        folder: folder,
        resource_type: 'auto',
      });

      if (fs.existsSync(localFilePath)) {
        try { fs.unlinkSync(localFilePath); } catch (_) {}
      }

      return response.secure_url;
    }
  } catch (error) {
    console.error('Cloudinary upload error, using local file fallback:', error.message || error);
  }

  // Resilient fallback: Return local uploads path so post upload NEVER fails
  if (localFilePath && fs.existsSync(localFilePath)) {
    const filename = path.basename(localFilePath);
    return `/uploads/${filename}`;
  }

  return null;
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
};

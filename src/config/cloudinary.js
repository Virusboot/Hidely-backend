const cloudinary = require('cloudinary').v2;
const fs = require('fs');
require('dotenv').config();

// Configure Cloudinary credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Uploads a local file to Cloudinary and unlinks the local file.
 * @param {string} localFilePath - Path to the local file saved by Multer
 * @param {string} folder - Cloudinary folder/category
 * @returns {Promise<string>} - Secure URL of the uploaded asset
 */
const uploadToCloudinary = async (localFilePath, folder = 'hidely') => {
  try {
    if (!localFilePath) return null;

    // Upload to Cloudinary with auto resource type detection (images/videos)
    const response = await cloudinary.uploader.upload(localFilePath, {
      folder: folder,
      resource_type: 'auto',
    });

    // Remove file from local uploads folder to keep disk clean
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }

    return response.secure_url;
  } catch (error) {
    console.error('Cloudinary upload failed:', error);
    // Clean up local file even if upload fails
    if (fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
      } catch (unlinkError) {
        console.error('Failed to delete temporary local file:', unlinkError);
      }
    }
    throw error;
  }
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
};

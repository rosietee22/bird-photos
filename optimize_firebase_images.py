import os
import firebase_admin
from firebase_admin import credentials, storage
from PIL import Image
import io

# ✅ Initialize Firebase
cred = credentials.Certificate("firebase_key.json")  # Your Firebase service account key
firebase_admin.initialize_app(cred, {
    'storageBucket': 'bird-pictures-953b0.firebasestorage.app'  # Replace with your Firebase storage bucket
})

bucket = storage.bucket()

# ✅ Detect affected images dynamically
EXCLUDED_IMAGE = "20241019_163653.jpg"  # The only image we want to exclude
KNOWN_AFFECTED_PREFIX = "202"  # Any file starting with "202"
ADDITIONAL_AFFECTED_IMAGES = ["bird2.jpg", "bird3.jpg"]  # Other images to rotate

# ✅ Function to correct image orientation
def correct_orientation(image, filename):
    width, height = image.size

    # 🔄 Rotate 180° if filename is in the affected list
    if (filename.startswith(KNOWN_AFFECTED_PREFIX) and filename != EXCLUDED_IMAGE) or filename in ADDITIONAL_AFFECTED_IMAGES:
        print(f"🔄 Fixing upside-down image: {filename}")
        image = image.rotate(180, expand=True)  # Rotate 180° to correct it

    return image

# ✅ Function to optimize and re-upload images
def optimize_image(image_data, filename, format="WEBP", quality=80):
    image = Image.open(io.BytesIO(image_data))

    # ✅ Fix rotation if necessary
    image = correct_orientation(image, filename)

    # ✅ Convert to RGB if needed
    if image.mode in ("RGBA", "P"):
        image = image.convert("RGB")

    # ✅ Save optimized image
    buffer = io.BytesIO()
    image.save(buffer, format=format, quality=quality)
    buffer.seek(0)

    return buffer.getvalue()

# ✅ Process all images in Firebase Storage
blobs = list(bucket.list_blobs())
for blob in blobs:
    if blob.name.endswith(('.jpg', '.jpeg', '.png', '.webp')):  
        print(f"📷 Processing {blob.name}...")

        # ✅ Download image
        image_data = blob.download_as_bytes()

        # ✅ Optimize and correct orientation
        optimized_data = optimize_image(image_data, blob.name)

        # ✅ Re-upload the optimized image (overwrite original)
        blob.upload_from_string(optimized_data, content_type="image/webp")
        print(f"✅ Image corrected and updated: {blob.name}")

print("🎉 All affected images should now be correctly oriented in Firebase!")

import os
import firebase_admin
from firebase_admin import credentials, storage
from PIL import Image
import io

# Initialize Firebase
cred = credentials.Certificate("firebase_key.json")  # Your Firebase service account key
firebase_admin.initialize_app(cred, {
    'storageBucket': 'bird-pictures-953b0.firebasestorage.app'  # Replace with your Firebase storage bucket
})

bucket = storage.bucket()

# Function to optimize an image
def optimize_image(image_data, format="WEBP", quality=80):
    image = Image.open(io.BytesIO(image_data))
    
    # Convert to RGB if needed (for PNG/JPEG)
    if image.mode in ("RGBA", "P"):
        image = image.convert("RGB")

    # Save optimized image to a buffer
    buffer = io.BytesIO()
    image.save(buffer, format=format, quality=quality)
    buffer.seek(0)
    
    return buffer.getvalue()

# Get all image files in Firebase Storage
blobs = list(bucket.list_blobs())
for blob in blobs:
    if blob.name.endswith(('.jpg', '.jpeg', '.png')):  # Process only images
        print(f"Processing {blob.name}...")

        # Download image
        image_data = blob.download_as_bytes()

        # Optimize image
        optimized_data = optimize_image(image_data)

        # Re-upload the optimized image (overwrite original)
        blob.upload_from_string(optimized_data, content_type="image/webp")
        print(f"✅ Optimized and re-uploaded: {blob.name}")

print("🎉 All images optimized and updated in Firebase!")

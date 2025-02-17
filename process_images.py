import os
import sqlite3
import exifread
import requests
from datetime import datetime
from google.cloud import storage
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut
import time
import ssl
import json
from google.oauth2 import service_account

# ✅ Load Firebase credentials from environment variable
credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")

if credentials_json:
    credentials_dict = json.loads(credentials_json)
    credentials = service_account.Credentials.from_service_account_info(credentials_dict)
    storage_client = storage.Client(credentials=credentials)
else:
    raise ValueError("❌ GOOGLE_APPLICATION_CREDENTIALS_JSON is not set in environment variables")

ssl._create_default_https_context = ssl._create_unverified_context

geolocator = Nominatim(user_agent="MyBirdPhotoApp")

# ✅ Firebase bucket settings
bucket_name = "bird-pictures-953b0.appspot.com"  # 🔹 Replace with your actual bucket name
bucket = storage_client.bucket(bucket_name)
firebase_base_url = f"https://storage.googleapis.com/{bucket_name}/"

def convert_to_decimal(gps_data):
    """Convert GPS data to decimal format."""
    degrees, minutes, seconds = gps_data
    return float(degrees) + (float(minutes) / 60) + (float(seconds.num) / float(seconds.den) / 3600)

def extract_metadata(image_url):
    """Download the image temporarily to extract metadata."""
    try:
        response = requests.get(image_url, stream=True)
        response.raise_for_status()

        with open("temp_image.jpg", "wb") as temp_file:
            for chunk in response.iter_content(1024):
                temp_file.write(chunk)

        with open("temp_image.jpg", 'rb') as image_file:
            tags = exifread.process_file(image_file)

        date_taken_raw = tags.get('EXIF DateTimeOriginal')
        date_taken = None
        if date_taken_raw:
            try:
                date_taken = datetime.strptime(str(date_taken_raw), "%Y:%m:%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                date_taken = None

        latitude = tags.get('GPS GPSLatitude')
        longitude = tags.get('GPS GPSLongitude')
        city_name = "Unknown"

        if latitude and longitude:
            latitude = convert_to_decimal(latitude.values)
            longitude = convert_to_decimal(longitude.values)
            
            for attempt in range(3):
                try:
                    location = geolocator.reverse((latitude, longitude), language="en", timeout=10)
                    city_name = location.raw.get("address", {}).get("city", "Unknown") if location else "Unknown"
                    break
                except GeocoderTimedOut:
                    time.sleep(2)

    except Exception as e:
        print(f"❌ Error fetching metadata for {image_url}: {e}")
        date_taken, latitude, longitude, city_name = None, None, None, "Unknown"

    return {
        "image_url": image_url,
        "date_taken": date_taken,
        "latitude": latitude,
        "longitude": longitude,
        "location": city_name
    }

def sync_database_with_firebase():
    """Sync database by removing images that are no longer in Firebase."""
    conn = sqlite3.connect("birds.db")
    cursor = conn.cursor()

    # ✅ Get all existing image URLs from the database
    cursor.execute("SELECT image_filename FROM bird_photos")
    stored_images = {row[0] for row in cursor.fetchall()}

    # ✅ Get all images from Firebase Storage
    blobs = bucket.list_blobs()
    firebase_images = {firebase_base_url + blob.name for blob in blobs if blob.name.lower().endswith(('.jpg', '.jpeg', '.png'))}

    # 🗑️ Delete images from the database that no longer exist in Firebase
    missing_images = stored_images - firebase_images
    for missing in missing_images:
        cursor.execute("DELETE FROM bird_photos WHERE image_filename = ?", (missing,))
        print(f"🗑️ Deleted {missing} from the database (image no longer in Firebase).")

    conn.commit()
    conn.close()

def insert_new_images_from_firebase():
    """Insert new images from Firebase Storage into the database."""
    conn = sqlite3.connect("birds.db")
    cursor = conn.cursor()

    blobs = bucket.list_blobs()
    firebase_images = {firebase_base_url + blob.name for blob in blobs if blob.name.lower().endswith(('.jpg', '.jpeg', '.png'))}

    for image_url in firebase_images:
        cursor.execute("SELECT 1 FROM bird_photos WHERE image_filename = ?", (image_url,))
        exists = cursor.fetchone()

        if not exists:
            # 🆕 Extract metadata and insert into the database
            image_data = extract_metadata(image_url)

            cursor.execute("""
                INSERT INTO bird_photos (image_filename, date_taken, location, latitude, longitude)
                VALUES (?, ?, ?, ?, ?)
            """, (image_url, image_data['date_taken'], image_data['location'], image_data['latitude'], image_data['longitude']))
            print(f"✅ Inserted {image_url} into the database.")

    conn.commit()
    conn.close()

def process_images():
    """Main function to process images from Firebase."""
    print("\n🔄 Syncing database with Firebase Storage...")
    sync_database_with_firebase()  # ✅ Remove missing images
    insert_new_images_from_firebase()  # ✅ Add new images

    print("\n✅ Database sync complete!")

process_images()

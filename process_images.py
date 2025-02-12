import os
import sqlite3
import exifread
from datetime import datetime
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut
import time
import ssl

ssl._create_default_https_context = ssl._create_unverified_context

geolocator = Nominatim(user_agent="MyBirdPhotoApp")

def convert_to_decimal(gps_data):
    degrees, minutes, seconds = gps_data
    return float(degrees) + (float(minutes) / 60) + (float(seconds.num) / float(seconds.den) / 3600)

def extract_metadata(image_path):
    with open(image_path, 'rb') as image_file:
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

    return {
        "image_filename": f"/images/{os.path.basename(image_path)}",  # Add /images/ prefix
        "date_taken": date_taken,
        "latitude": latitude,
        "longitude": longitude,
        "location": city_name
    }

def sync_database_with_folder(folder_path):
    conn = sqlite3.connect("birds.db")
    cursor = conn.cursor()

    cursor.execute("SELECT image_filename FROM bird_photos")
    stored_images = {row[0] for row in cursor.fetchall()}
    folder_images = {f"/images/{file}" for file in os.listdir(folder_path) if file.lower().endswith(('.jpg', '.jpeg', '.png'))}

    missing_images = stored_images - folder_images
    for missing in missing_images:
        cursor.execute("DELETE FROM bird_photos WHERE image_filename = ?", (missing,))
        print(f"🗑️ Deleted {missing} from the database (image no longer in folder).")

    conn.commit()
    conn.close()

def insert_new_images(folder_path):
    conn = sqlite3.connect("birds.db")
    cursor = conn.cursor()

    for filename in os.listdir(folder_path):
        if filename.lower().endswith(('.jpg', '.jpeg', '.png')):
            image_filename = f"/images/{filename}"  # Ensure consistent filename format

            # ✅ Check if the image already exists in the database
            cursor.execute("SELECT 1 FROM bird_photos WHERE image_filename = ?", (image_filename,))
            exists = cursor.fetchone()

            if not exists:
                # 🆕 New image: Extract metadata and insert into the database
                image_path = os.path.join(folder_path, filename)
                image_data = extract_metadata(image_path)

                cursor.execute("""
                    INSERT INTO bird_photos (image_filename, date_taken, location, latitude, longitude)
                    VALUES (?, ?, ?, ?, ?)
                """, (image_filename, image_data['date_taken'], image_data['location'], image_data['latitude'], image_data['longitude']))
                print(f"✅ Inserted {image_filename} into the database.")

    conn.commit()
    conn.close()

def process_images(folder_path):
    if not os.path.exists(folder_path):
        print(f"Error: Folder '{folder_path}' not found.")
        return
    
    print("\n🔄 Syncing database with folder (checking for added or deleted images)...")
    sync_database_with_folder(folder_path)  # ✅ Only delete missing images
    insert_new_images(folder_path)  # ✅ Only insert new images

    print("\n✅ Database sync complete!")

folder_path = "public/images"
process_images(folder_path)

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

firebase_credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
if firebase_credentials_json:
    credentials_dict = json.loads(firebase_credentials_json)
    credentials = service_account.Credentials.from_service_account_info(credentials_dict)
else:
    raise ValueError("❌ No valid Firebase credentials found.")

storage_client = storage.Client(credentials=credentials)

def get_firebase_image_url(blob_name):
    """Generate the correct Firebase Storage public URL"""
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{blob_name}?alt=media"

bucket_name = "bird-pictures-953b0.firebasestorage.app"
bucket = storage_client.bucket(bucket_name)

ssl._create_default_https_context = ssl._create_unverified_context
geolocator = Nominatim(user_agent="MyBirdPhotoApp")

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
        
        date_taken = tags.get('EXIF DateTimeOriginal')
        if date_taken:
            try:
                date_taken = datetime.strptime(str(date_taken), "%Y:%m:%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S")
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

INATURALIST_API_URL = "https://api.inaturalist.org/v1/computervision/score_image"

def get_species_suggestions(image_url):
    """Send an image to iNaturalist API for species recognition."""
    try:
        response = requests.get(image_url, stream=True)
        response.raise_for_status()
        
        files = {"image": ("bird.jpg", response.content)}
        api_response = requests.post(INATURALIST_API_URL, files=files)
        api_response.raise_for_status()
        data = api_response.json()
        
        species_suggestions = [entry["taxon"]["name"] for entry in data.get("results", [])[:3]]
        return ", ".join(species_suggestions) if species_suggestions else "Unknown"
    except Exception as e:
        print(f"❌ AI Error fetching species for {image_url}: {e}")
        return "Unknown"

db_path = "/persistent/birds.db"

def sync_database_with_firebase():
    """Sync database by removing images that are no longer in Firebase."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("SELECT image_filename FROM bird_photos")
    stored_images = {row[0] for row in cursor.fetchall()}
    
    blobs = bucket.list_blobs()
    firebase_images = {get_firebase_image_url(blob.name) for blob in blobs if blob.name.lower().endswith(('.jpg', '.jpeg', '.png', '.heic'))}
    
    missing_images = stored_images - firebase_images
    for missing in missing_images:
        cursor.execute("DELETE FROM bird_photos WHERE image_filename = ?", (missing,))
        print(f"🗑️ Deleted {missing} from the database (image no longer in Firebase).")
    
    conn.commit()
    conn.close()

def insert_new_images_from_firebase():
    """Insert new images from Firebase Storage into the database with AI species recognition."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    blobs = bucket.list_blobs()
    firebase_images = {get_firebase_image_url(blob.name) for blob in blobs if blob.name.lower().endswith(('.jpg', '.jpeg', '.png'))}
    
    for image_url in firebase_images:
        cursor.execute("SELECT 1 FROM bird_photos WHERE image_filename = ?", (image_url,))
        exists = cursor.fetchone()

        if not exists:
            image_data = extract_metadata(image_url)
            species_suggestions = get_species_suggestions(image_url)
            
            cursor.execute("""
                INSERT INTO bird_photos (image_filename, date_taken, location, latitude, longitude, species_suggestions)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (image_url, image_data['date_taken'], image_data['location'], image_data['latitude'], image_data['longitude'], species_suggestions))
            print(f"✅ Inserted {image_url} into the database with AI species suggestions: {species_suggestions}")
    
    conn.commit()
    conn.close()

def process_images():
    """Main function to process images from Firebase."""
    print("\n🔄 Syncing database with Firebase Storage...")
    sync_database_with_firebase()
    insert_new_images_from_firebase()
    print("\n✅ Database sync complete!")

process_images()

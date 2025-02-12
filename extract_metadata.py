import exifread
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut
import ssl

# Disable SSL verification (if needed)
ssl._create_default_https_context = ssl._create_unverified_context

# Initialize the geolocator with a unique user-agent string
geolocator = Nominatim(user_agent="MyBirdPhotoApp")

def convert_to_decimal(gps_data):
    """Convert EXIF GPS coordinates to decimal format."""
    degrees, minutes, seconds = gps_data
    return float(degrees) + (float(minutes) / 60) + (float(seconds.num) / float(seconds.den) / 3600)

def extract_metadata(image_path):
    print("Script started...")

    with open(image_path, 'rb') as image_file:
        tags = exifread.process_file(image_file)
        print("Metadata extracted...")

        # Extract date and time
        date_taken = tags.get('EXIF DateTimeOriginal')
        print(f"Date Taken: {date_taken}")

        # Extract GPS coordinates
        latitude = tags.get('GPS GPSLatitude')
        longitude = tags.get('GPS GPSLongitude')

        # Convert coordinates to decimal format
        if latitude and longitude:
            latitude = convert_to_decimal(latitude.values)
            longitude = convert_to_decimal(longitude.values)

            # Convert coordinates to city name using Nominatim (bypassing SSL verification)
            print("Attempting to get city name...")
            try:
                location = geolocator.reverse((latitude, longitude), language="en")
                if location:
                    city_name = location.raw.get("address", {}).get("city", "Unknown")
                else:
                    city_name = "Unknown"
            except GeocoderTimedOut:
                city_name = "Timeout"
        else:
            city_name = "Unknown"

        print(f"City: {city_name}")
        print(f"Latitude: {latitude}, Longitude: {longitude}")
        print("-" * 30)

# Replace 'test_photo.jpg' with your actual image filename
extract_metadata("test_photo.jpg")

import firebase_admin
from firebase_admin import credentials, storage

# Load Firebase credentials
cred = credentials.Certificate("firebase_key.json")
firebase_admin.initialize_app(cred, {
    'storageBucket': 'bird-pictures-953b0.firebasestorage.app'
})

# Access Firebase Storage
try:
    bucket = storage.bucket()
    blobs = list(bucket.list_blobs())

    if blobs:
        print("✅ Firebase Storage Access: SUCCESS!")
        for blob in blobs[:10]:  # Print first 10 files
            print(blob.name)
    else:
        print("⚠️ No files found, but access is working!")

except Exception as e:
    print("❌ Firebase Storage Error:", e)


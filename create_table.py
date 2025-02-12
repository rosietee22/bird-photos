import sqlite3

def create_tables():
    conn = sqlite3.connect("/Users/rosiethomas/Desktop/bird_photos/birds.db")
    cursor = conn.cursor()

    # Create the bird_species table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS bird_species (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            common_name TEXT,
            scientific_name TEXT,
            description TEXT
        )
    """)

    # Create the bird_photos table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS bird_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_filename TEXT,
            date_taken TEXT,
            location TEXT,
            latitude REAL,
            longitude REAL,
            species_id INTEGER,
            FOREIGN KEY (species_id) REFERENCES bird_species(id)
        )
    """)

    conn.commit()
    conn.close()

# Run the create_tables function to set up the database
create_tables()
print("Tables created successfully!")
